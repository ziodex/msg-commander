using System.Diagnostics;
using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Application.ServiceBus.Gateways;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Maintenance;
using static MsgCommander.Application.ServiceBus.Maintenance.MaintenancePolicies;
using MsgCommander.Contracts.Connections;

namespace MsgCommander.Application.ServiceBus.Maintenance;

/// <summary>Connection-scoped recovery receipts; callers serialize operations with their connection gate.</summary>
public sealed partial class DeadLetterRecoveryService(IServiceBusMessagingGateway gateway, ConnectRecoveryDestination connectDestination, string namespaceName,
	Func<bool> hasInteractiveReceiver, Action invalidateSnapshots, IMaintenanceFailureClassifier failures)
{
	public ResendResult? GetResult(string id) => resends.Get(id);
	public ResendResult? CheckRequest(string id, string fingerprint) => resends.CheckRequest(id, fingerprint);
	public void Clear() => resends.Clear();
	private readonly OperationReceipts<ResendResult> resends = new(1000, "Resend operation ID was already used for a different request.", "The resend receipt limit is reached. Review results before reconnecting.");
	public async Task<ResendResult> ExecuteAsync(ResendDeadLetters request, string fingerprint, Func<ResendProgress, Task> emit, Func<MsgCommander.Contracts.Connections.DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		var operationId = request.Id;
		if (CheckRequest(operationId, fingerprint) is { } previous)
			return previous;
		var source = request.Source;
		source.Validate(peek: true);
		var destination = request.Destination;
		OutgoingMessages.ValidateDestination(destination);
		var subQueue = request.SubQueue;
		if (subQueue is not ("dead-letter" or "transfer-dead-letter"))
			throw new OperationException(OperationFailure.InvalidInput, "Choose a dead-letter or transfer dead-letter source.");
		var mode = request.Mode;
		var policy = request.IdPolicy;
		var maxMessages = request.MaxMessages;
		var maxSeconds = request.MaxSeconds;
		if (mode is not ("keep" or "remove") || policy is not ("new" or "preserve") || maxMessages is < 1 or > 1000 || maxSeconds is < 1 or > 600)
			throw new OperationException(OperationFailure.InvalidInput, "Choose a valid original-message behavior and message ID policy. Use 1–1000 messages and 1–600 seconds.");
		if (hasInteractiveReceiver())
			throw new OperationException(OperationFailure.OperationBlocked, "Close the current message or session receiver before resending dead letters. Held messages are not included.");

		if (request.CrossNamespace is not null)
			return await AcrossNamespacesAsync(request.CrossNamespace, operationId, fingerprint, source, subQueue, destination, mode, policy, maxMessages, maxSeconds, emit, deviceCode, cancellation);

		var clock = Stopwatch.StartNew();
		using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(maxSeconds));
		using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation, deadline.Token);
		var token = lifetime.Token;
		IMessageReceiver? receiver = null;
		var examined = 0;
		var sent = 0;
		var removed = 0;
		var uncertain = 0;
		var dispatching = false;
		var status = "completed";
		var reason = "no-available-messages";
		string? detail = null, cleanupWarning = null, sourceSequence = null, outgoingId = null;
		long cursor = 0, lastProgress = -1000;
		HashSet<string?> sentIds = [];
		async Task Progress(string phase, bool force = false)
		{
			if (!force && clock.ElapsedMilliseconds - lastProgress < 250)
				return;
			lastProgress = clock.ElapsedMilliseconds;
			await emit(new(operationId, examined, sent, removed, uncertain, maxMessages, clock.ElapsedMilliseconds, phase));
		}
		try
		{
			await Progress("opening", true);
			token.ThrowIfCancellationRequested();
			await gateway!.GetEntityAsync(source, token);
			await gateway.GetEntityAsync(destination, token);
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
						throw new OperationException(OperationFailure.ReceiverContractViolation, "Dead-letter paging did not advance. Resend stopped without repeating the message.");
				}
				else
				{
					await Progress("receiving");
					var batch = await receiver!.ReceiveAsync(1, TimeSpan.FromSeconds(2), token);
					if (batch.Count > 1)
						throw new OperationException(OperationFailure.ReceiverContractViolation, "Unexpected receive batch. Resend stopped without sending or completing that batch.");
					original = batch.FirstOrDefault();
				}
				if (original is null)
					break;
				examined++;
				sourceSequence = MsgCommander.Application.Common.DisplayValues.Number(original.SequenceNumber);
				outgoingId = null;
				token.ThrowIfCancellationRequested();
				if (sentIds.Contains(original.MessageId))
				{
					status = "limited";
					reason = "feedback-detected";
					break;
				}
				// One broker message at a time; the messaging port preserves exact bytes and typed properties.
				outgoingId = policy == "preserve" ? original.MessageId : Guid.NewGuid().ToString();
				var outgoing = OutgoingMessages.Replay(original, policy, outgoingId);
				await Progress(mode == "keep" ? "sending" : "transferring", true);
				token.ThrowIfCancellationRequested();
				dispatching = true;
				if (mode == "keep")
					await gateway.SendAsync(destination, outgoing, token);
				else
					await receiver!.ReplayAsync(original, destination, outgoing, token);
				// An acknowledged send/transaction wins a concurrent cancellation.
				dispatching = false;
				sent++;
				sentIds.Add(outgoingId);
				if (mode == "remove")
					removed++;
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
			var failure = failures.Classify(error, MaintenanceOperation.Resend);
			var rejected = failure.IsRejected;
			uncertain = dispatching && !rejected ? 1 : 0;
			if (uncertain > 0)
			{
				status = "unknown";
				reason = "error";
				detail = "The last send or transaction may have committed. It was not retried. Inspect source and destination using the recorded sequence and outgoing message ID before another resend.";
			}
			else if (token.IsCancellationRequested && error is OperationCanceledException)
			{
				status = cancellation.IsCancellationRequested ? "cancelled" : "limited";
				reason = cancellation.IsCancellationRequested ? "cancelled" : "time-limit";
			}
			else
			{
				status = "failed";
				reason = "error";
				detail = failure.SafeDetail ?? "Resend stopped after a broker or connection error. Check permissions, message properties and transaction support. No automatic retry was made.";
			}
		}
		finally
		{
			try
			{
				await Progress("closing", true);
			}
			catch
			{
				// The receipt remains authoritative.
			}
			try
			{
				if (receiver is not null)
					await receiver.DisposeAsync();
			}
			catch { cleanupWarning = "Receiver cleanup could not be confirmed. Unsettled originals may remain locked until expiry."; }
		}
		var stop = reason switch
		{
			"message-limit" => "Message limit reached.",
			"time-limit" => "Time limit reached.",
			"cancelled" => "Cancelled. Confirmed resends cannot be undone.",
			"feedback-detected" => "A message ID already resent in this job appeared in the dead-letter queue. Stopped before resending it again; fix the dead-letter cause or review duplicate IDs.",
			"no-available-messages" => "No further messages were returned in this read window; the dead-letter queue is not guaranteed empty.",
			_ => detail ?? "Resend stopped."
		};
		var summary = $"{sent} resends confirmed; {removed} originals removed; {uncertain} outcome(s) uncertain. {stop}";
		var result = new ResendResult(operationId, source, subQueue, destination, mode, policy, status, reason, examined, sent, removed, uncertain, clock.ElapsedMilliseconds, sourceSequence, outgoingId, summary, cleanupWarning, namespaceName, namespaceName, false, 0, []);
		resends.Add(operationId, fingerprint, result);
		if (examined > 0)
			invalidateSnapshots();
		try
		{
			await Progress("finished", true);
		}
		catch
		{
			// Keep the result after progress transport loss.
		}
		return result;
	}
}
