using System.Diagnostics;
using System.Globalization;
using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Messages;
using MsgCommander.Contracts.ServiceBus.Maintenance;
using static MsgCommander.Application.Common.DisplayValues;
using static MsgCommander.Application.ServiceBus.Messages.MessageProjection;
using static MsgCommander.Application.ServiceBus.Maintenance.MaintenancePolicies;

namespace MsgCommander.Application.ServiceBus.Maintenance;

/// <summary>Connection-scoped purge receipts and a sequential, bounded completion engine.</summary>
public sealed class PurgeService(IServiceBusMessagingGateway gateway, string namespaceName,
	Func<bool> hasInteractiveReceiver, Action invalidateSnapshots, IMaintenanceFailureClassifier failures)
{
	public PurgeResult? GetResult(string id) => purges.Get(id);
	public PurgeResult? CheckRequest(string id, string fingerprint) => purges.CheckRequest(id, fingerprint);
	public void Clear() => purges.Clear();
	private readonly OperationReceipts<PurgeResult> purges = new(1000, "Purge operation ID was already used for a different request.", "The purge receipt limit is reached. Reconnect after reviewing results.");
	public async Task<PurgeResult> ExecuteAsync(PurgeMessages request, string fingerprint, Func<PurgeProgress, Task> emit, CancellationToken cancellation)
	{
		var operationId = request.Id;
		if (CheckRequest(operationId, fingerprint) is { } previous)
			return previous;
		var target = request.Target;
		target.Validate(peek: true);
		var subQueue = request.SubQueue;
		var maxMessages = request.MaxMessages;
		var maxSeconds = request.MaxSeconds;
		var cutoff = ParseCutoff(request.Cutoff);
		var path = target.Kind == "queue" ? target.Name : $"{target.TopicName}/Subscriptions/{target.Name}";
		var expected = $"PURGE {namespaceName}/{path}/{subQueue}" + (cutoff is null ? "" : $" BEFORE {CutoffText(cutoff)}");
		if (subQueue is not ("active" or "dead-letter" or "transfer-dead-letter") || maxMessages is < 1 or > 100000 || maxSeconds is < 1 or > 600 ||
			request.Confirmation != expected)
			throw new OperationException(OperationFailure.InvalidInput, "Confirm the exact namespace, entity and subqueue. Use a message limit of 1–100000 and a time limit of 1–600 seconds.");
		if (hasInteractiveReceiver())
			throw new OperationException(OperationFailure.OperationBlocked, "Close the current message or session receiver before starting a purge. No held messages are settled by purge.");

		var result = await RunAsync(operationId, target, subQueue, maxMessages, TimeSpan.FromSeconds(maxSeconds), cutoff, progress => emit(progress), cancellation);
		purges.Add(operationId, fingerprint, result);
		return result;
	}

	// Shared sequential engine: bulk jobs own their aggregate receipt and global budgets.
	internal async Task<PurgeResult> RunAsync(string operationId, EntityTarget target, string subQueue, int maxMessages,
		TimeSpan duration, DateTimeOffset? cutoff, Func<PurgeProgress, Task> emit, CancellationToken cancellation)
	{
		var clock = Stopwatch.StartNew();
		using var deadline = new CancellationTokenSource(duration);
		using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation, deadline.Token);
		var token = lifetime.Token;
		IMessageReceiver? receiver = null;
		var received = 0;
		var completed = 0;
		var uncertain = 0;
		var skipped = 0;
		HashSet<long> retained = [];
		HashSet<string> visitedSessions = new(StringComparer.Ordinal);
		var completing = false;
		var status = "completed";
		var reason = "no-available-messages";
		string? detail = null, cleanupWarning = null;
		long lastProgress = -1000;
		async Task Progress(string phase, bool force = false)
		{
			if (!force && clock.ElapsedMilliseconds - lastProgress < 250)
				return;
			lastProgress = clock.ElapsedMilliseconds;
			await emit(new(operationId, received, completed, uncertain, maxMessages, clock.ElapsedMilliseconds, phase, CutoffText(cutoff), skipped));
		}
		async Task ClosePurgeReceiver()
		{
			var old = receiver;
			receiver = null;
			if (old is not null)
				await old.DisposeAsync();
		}
		try
		{
			await Progress("opening", true);
			token.ThrowIfCancellationRequested();
			var entity = await gateway!.GetEntityAsync(target, token);
			var sessions = subQueue == "active" && entity.Entity.RequiresSession == true;
			while (completed < maxMessages)
			{
				token.ThrowIfCancellationRequested();
				if (cutoff is not null && received >= 100000)
				{
					status = "limited";
					reason = "scan-limit";
					break;
				}
				if (receiver is null)
				{
					await Progress("opening");
					if (sessions)
					{
						if (cutoff is not null && visitedSessions.Count >= 1000)
						{
							status = "limited";
							reason = "scan-limit";
							detail = "Stopped after visiting 1000 sessions. Older messages may remain.";
							break;
						}
						// The SDK timeout here means no session was acquired in its wait window, not proof of an empty entity.
						try
						{
							receiver = await gateway.OpenNextSessionAsync(target, token);
						}
						catch (Exception error) when (failures.Classify(error, MaintenanceOperation.Purge).IsTimeout) { token.ThrowIfCancellationRequested(); break; }
						// Accept-next may return a session whose retained newer messages are still available.
						// Never cycle through it: closing/reaccepting can increase delivery counts.
						if (cutoff is not null && (receiver.SessionId is null || !visitedSessions.Add(receiver.SessionId)))
						{
							status = "limited";
							reason = "session-revisited";
							break;
						}
					}
					else
						receiver = await gateway.OpenReceiverAsync(target, subQueue, "", token);
				}
				token.ThrowIfCancellationRequested();
				if (receiver.SessionLockedUntil is DateTimeOffset until && until < DateTimeOffset.UtcNow.AddSeconds(15))
				{
					await Progress("renewing");
					await receiver.RenewSessionLockAsync(token);
				}
				await Progress("receiving");
				var batch = await receiver.ReceiveAsync(1, TimeSpan.FromSeconds(2), token);
				// Never prefetch or accumulate bodies. One SDK transfer may still contain a large message.
				received += batch.Count;
				token.ThrowIfCancellationRequested();
				if (batch.Count == 0)
				{
					if (!sessions)
						break;
					await ClosePurgeReceiver();
					continue;
				}
				if (batch.Count != 1)
					throw new OperationException(OperationFailure.ReceiverContractViolation, "The receiver returned an unexpected batch. Purge stopped without completing it.");
				if (cutoff is DateTimeOffset before)
				{
					var message = batch[0];
					if (retained.Contains(message.SequenceNumber))
					{
						status = "limited";
						reason = "redelivery";
						break;
					}
					if (message.EnqueuedTime == default)
						throw new OperationException(OperationFailure.ReceiverContractViolation, "The broker enqueue time is unavailable. Purge stopped without completing this message.");
					if (!MsgCommander.Domain.ServiceBus.Messages.PurgeCutoff.Includes(before, message.EnqueuedTime))
					{
						// No abandon, defer, resubmit or complete for an ineligible message. Keep only its
						// sequence number; receiver cleanup/lock expiry releases the delivery.
						retained.Add(message.SequenceNumber);
						skipped++;
						await Progress("retaining", skipped == 1);
						if (skipped >= 100)
						{
							status = "limited";
							reason = "retention-limit";
							break;
						}
						continue;
					}
				}
				await Progress("completing", completed == 0);
				token.ThrowIfCancellationRequested();
				completing = true;
				await receiver.SettleAsync(batch[0], "complete", "", "", token);
				completing = false;
				completed++; // Acknowledgement wins cancellation races.
				await Progress("receiving", completed == 1);
			}
			if (completed == maxMessages)
			{
				status = "limited";
				reason = "message-limit";
			}
		}
		catch (Exception error)
		{
			var failure = failures.Classify(error, MaintenanceOperation.Purge);
			var rejected = failure.IsRejected;
			uncertain = completing && !rejected ? 1 : 0;
			if (uncertain > 0)
			{
				status = "unknown";
				reason = "error";
				detail = "The last completion may have been applied. It was not retried.";
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
				detail = failure.SafeDetail ?? "Purge stopped after a broker or connection error. Check access and connectivity before a new purge.";
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
				// Keep the result even if progress delivery is lost.
			}
			try
			{
				await ClosePurgeReceiver();
			}
			catch { cleanupWarning = "Receiver cleanup could not be confirmed. Unsettled messages may remain locked until expiry."; }
		}
		var stop = reason switch
		{
			"message-limit" => "Message limit reached.",
			"time-limit" => "Time limit reached.",
			"cancelled" => "Cancelled. Completed deletions cannot be undone.",
			"retention-limit" => "Stopped after retaining 100 messages at or after the cutoff. Older messages may remain.",
			"scan-limit" => detail ?? "Stopped after 100000 received messages. Older messages may remain.",
			"redelivery" => "A retained message was delivered again. Stopped to avoid repeated locking; older messages may remain.",
			"session-revisited" => "A session was offered again. Stopped to avoid repeated locking; older messages may remain in this or other sessions.",
			"no-available-messages" => "No further available messages were returned in the wait window; the entity is not guaranteed empty.",
			_ => detail ?? "Purge stopped."
		};
		var summary = $"{completed} deletions confirmed; {uncertain} completion(s) uncertain. {stop}";
		if (cutoff is not null)
			summary += $" {skipped} messages at or after {CutoffText(cutoff)} left unsettled.";
		var result = new PurgeResult(operationId, target, subQueue, status, reason, received, completed, uncertain, clock.ElapsedMilliseconds, summary, cleanupWarning, CutoffText(cutoff), skipped);
		if (received > 0)
			invalidateSnapshots();
		try
		{
			await Progress("finished", true);
		}
		catch
		{
			// The retained receipt is authoritative.
		}
		return result;
	}
}
