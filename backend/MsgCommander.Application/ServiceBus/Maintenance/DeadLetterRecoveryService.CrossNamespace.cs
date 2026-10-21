using System.Diagnostics;
using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Application.ServiceBus.Gateways;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Maintenance;
using static MsgCommander.Application.ServiceBus.Maintenance.MaintenancePolicies;
using System.Text.Json;
using MsgCommander.Application.Connections;
using MsgCommander.Contracts.Connections;

namespace MsgCommander.Application.ServiceBus.Maintenance;

public sealed partial class DeadLetterRecoveryService
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	// Cross-namespace recovery is intentionally two independent writes. A destination send must be
	// acknowledged before source completion is dispatched; neither step is retried or rolled back.
	private async Task<ResendResult> AcrossNamespacesAsync(RecoveryDestination request, string operationId, string fingerprint,
		EntityTarget source, string subQueue, EntityTarget destination, string mode, string policy, int maxMessages, int maxSeconds,
		Func<ResendProgress, Task> emit, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		var profileId = request.ProfileId;
		var expectedNamespace = request.Namespace;
		var profile = request.Profile;
		if (!Guid.TryParse(profileId, out _) || profile is null || profile.Id != profileId || profile.Service != "service-bus" ||
			string.IsNullOrWhiteSpace(profile.Namespace) || profile.Namespace.Length > 253 || Uri.CheckHostName(profile.Namespace) != UriHostNameType.Dns ||
			!string.Equals(profile.Namespace, expectedNamespace, StringComparison.OrdinalIgnoreCase))
			throw new OperationException(OperationFailure.InvalidInput, "Destination connection changed or is invalid. Select a saved Service Bus destination and review it again.");
		var sourceNamespace = namespaceName;
		if (string.Equals(sourceNamespace, profile.Namespace, StringComparison.OrdinalIgnoreCase))
			throw new OperationException(OperationFailure.InvalidInput, "Use the current namespace destination for same-namespace recovery.");
		if (mode == "remove" && !request.AcknowledgeNonAtomic)
			throw new OperationException(OperationFailure.InvalidInput, "Acknowledge that the destination send and source completion are separate operations and can leave duplicates.");
		// A bounded connection-wide ledger prevents large batches from making retained receipts unbounded.
		var retainedRows = resends.Results.Sum(r => r.Transfers.Count);
		if (retainedRows + maxMessages > 5000)
			throw new OperationException(OperationFailure.OperationBlocked, "Recovery receipt capacity reached. Save and review receipts before reconnecting, or reduce the message limit.");
		var clock = Stopwatch.StartNew();
		using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(maxSeconds));
		using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation, deadline.Token);
		var token = lifetime.Token;
		var prompts = new DeviceCodePrompts();
		using var promptScope = prompts.Enter(deviceCode, token);
		IServiceBusMessagingGateway? destinationGateway = null;
		IMessageReceiver? receiver = null;
		List<ResendTransfer> transfers = [];
		var examined = 0;
		var sent = 0;
		var removed = 0;
		var uncertain = 0;
		var ledgerBytes = 0;
		string? dispatched = null, detail = null, cleanupWarning = null, sourceSequence = null, outgoingId = null;
		var status = "completed";
		var reason = "no-available-messages";
		long cursor = 0, lastProgress = -1000;
		HashSet<long> seenSequences = [];
		int CopiedNotRemoved() => mode == "remove" ? transfers.Count(t => t.Send == "confirmed" && t.Source != "removed") : 0;
		async Task Progress(string phase, bool force = false)
		{
			if (!force && clock.ElapsedMilliseconds - lastProgress < 250)
				return;
			lastProgress = clock.ElapsedMilliseconds;
			await emit(new(operationId, examined, sent, removed, uncertain, maxMessages, clock.ElapsedMilliseconds, phase, CopiedNotRemoved()));
		}
		try
		{
			await Progress("authenticating", true);
			token.ThrowIfCancellationRequested();
			destinationGateway = await connectDestination(profile, prompts.ForwardAsync, token);
			token.ThrowIfCancellationRequested();
			await gateway!.GetEntityAsync(source, token);
			await destinationGateway.GetEntityAsync(destination, token);
			if (mode == "remove")
				receiver = await gateway.OpenReceiverAsync(source, subQueue, "", token);
			while (sent < maxMessages)
			{
				token.ThrowIfCancellationRequested();
				ReceivedMessage? original;
				if (mode == "keep")
				{
					await Progress("peeking");
					original = await gateway.PeekOneAsync(source, subQueue, cursor, token);
					if (original is not null && original.SequenceNumber < cursor)
						throw new OperationException(OperationFailure.ReceiverContractViolation, "Dead-letter paging did not advance. Recovery stopped without sending that message again.");
				}
				else
				{
					await Progress("receiving");
					var batch = await receiver!.ReceiveAsync(1, TimeSpan.FromSeconds(2), token);
					if (batch.Count > 1)
						throw new OperationException(OperationFailure.ReceiverContractViolation, "Unexpected receive batch. Nothing in that batch was sent or completed.");
					original = batch.FirstOrDefault();
				}
				if (original is null)
					break;
				examined++;
				sourceSequence = MsgCommander.Application.Common.DisplayValues.Number(original.SequenceNumber);
				outgoingId = null;
				if (!seenSequences.Add(original.SequenceNumber))
					throw new OperationException(OperationFailure.ReceiverContractViolation, "A previously examined source sequence was returned again. Recovery stopped without resending it.");
				token.ThrowIfCancellationRequested();
				outgoingId = policy == "preserve" ? original.MessageId : Guid.NewGuid().ToString();
				var outgoing = OutgoingMessages.Replay(original, policy, outgoingId);
				// Preserve original application properties. The separate ledger records exact IDs for reconciliation.
				var transfer = new ResendTransfer(sourceSequence, original.MessageId, outgoingId, "not-sent", mode == "keep" ? "kept" : "not-removed");
				var transferBytes = JsonSerializer.SerializeToUtf8Bytes(transfer, Json).Length + 32;
				if (ledgerBytes + transferBytes > 600000)
				{
					status = "limited";
					reason = "receipt-limit";
					break;
				}
				transfers.Add(transfer);
				ledgerBytes += transferBytes;
				await Progress("sending", true);
				token.ThrowIfCancellationRequested();
				dispatched = "send";
				await destinationGateway.SendAsync(destination, outgoing, token);
				dispatched = null;
				sent++;
				transfers[^1] = transfers[^1] with
				{
					Send = "confirmed"
				};
				if (mode == "remove")
				{
					// Cancellation after send acknowledgement leaves the original untouched and records the copy.
					await Progress("completing", true);
					token.ThrowIfCancellationRequested();
					dispatched = "complete";
					await receiver!.SettleAsync(original, "complete", "", "", token);
					dispatched = null;
					removed++;
					transfers[^1] = transfers[^1] with
					{
						Source = "removed"
					};
				}
				await Progress(mode == "keep" ? "peeking" : "receiving", sent == 1);
				if (mode == "keep")
				{
					if (original.SequenceNumber == long.MaxValue)
						break;
					cursor = checked(original.SequenceNumber + 1);
				}
			}
			if (sent == maxMessages)
			{
				status = "limited";
				reason = "message-limit";
			}
		}
		catch (Exception error)
		{
			var failure = failures.Classify(error, MaintenanceOperation.CrossNamespaceResend);
			var rejected = failure.IsRejected;
			uncertain = dispatched is not null && !rejected ? 1 : 0;
			if (uncertain > 0)
			{
				transfers[^1] = dispatched == "send" ? transfers[^1] with
				{
					Send = "unknown"
				} : transfers[^1] with
				{
					Source = "unknown"
				};
				status = "unknown";
				reason = "error";
				detail = dispatched == "send" ? "The destination send may have succeeded. Source completion was not attempted."
					: "The destination send is confirmed; source completion may have succeeded.";
			}
			else if (error is OperationCanceledException && token.IsCancellationRequested)
			{
				status = cancellation.IsCancellationRequested ? "cancelled" : "limited";
				reason = cancellation.IsCancellationRequested ? "cancelled" : "time-limit";
			}
			else
			{
				status = "failed";
				reason = "error";
				detail = failure.SafeDetail ?? (dispatched == "complete" ? "The destination send is confirmed, but source completion was rejected."
					: "Recovery stopped after a connection, permission, message or broker error.");
			}
		}
		finally
		{
			prompts.Close();
			try
			{
				await Progress("closing", true);
			}
			catch { }
			try
			{
				if (receiver is not null)
					await receiver.DisposeAsync();
			}
			catch { cleanupWarning = "Source receiver cleanup could not be confirmed; its unsettled message may stay locked until expiry."; }
			try
			{
				if (destinationGateway is not null)
					await destinationGateway.DisposeAsync();
			}
			catch { cleanupWarning = (cleanupWarning is null ? "" : cleanupWarning + " ") + "Destination connection cleanup could not be confirmed."; }
		}
		var stop = reason switch
		{
			"receipt-limit" => "Receipt metadata limit reached. The last examined message was not sent or completed.",
			"message-limit" => "Message limit reached.",
			"time-limit" => "Time limit reached.",
			"cancelled" => "Cancelled.",
			"no-available-messages" => "No further messages returned in this read window; the source is not guaranteed empty.",
			_ => detail ?? "Recovery stopped."
		};
		var copies = CopiedNotRemoved();
		var summary = $"{sent} destination sends confirmed; {removed} originals removed; {uncertain} outcome(s) uncertain. {stop} Nothing was retried.";
		if (copies > 0)
			summary += $" {copies} confirmed {(copies == 1 ? "copy has" : "copies have")} no confirmed source removal. Review both namespaces using the receipt before retrying; another resend may duplicate them.";
		var result = new ResendResult(operationId, source, subQueue, destination, mode, policy, status, reason, examined, sent, removed, uncertain,
			clock.ElapsedMilliseconds, sourceSequence, outgoingId, summary, cleanupWarning, sourceNamespace, profile.Namespace, true, copies, transfers.AsReadOnly());
		resends.Add(operationId, fingerprint, result);
		if (examined > 0)
			invalidateSnapshots();
		try
		{
			await Progress("finished", true);
		}
		catch { }
		return result;
	}
}
