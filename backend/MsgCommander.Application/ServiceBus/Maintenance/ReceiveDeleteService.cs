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

namespace MsgCommander.Application.ServiceBus.Maintenance;

public sealed class ReceiveDeleteService(IServiceBusMessagingGateway gateway, string namespaceName,
	Func<bool> hasInteractiveReceiver, IMaintenanceFailureClassifier failures)
{
	private const int SnapshotBudget = MessageInspectionService.SnapshotBudget;
	public ReceiveDeleteResult? GetResult(string id) => receiveDeletes.Get(id);
	public ReceiveDeleteResult? CheckRequest(string id, string fingerprint) => receiveDeletes.CheckRequest(id, fingerprint);
	public void Clear()
	{
		receiveDeletes.Clear();
		consumedSnapshots.Clear();
	}
	public (ReceivedMessage Message, ReadOnlyMemory<byte> Body, MessageSummary Summary)? FindSnapshot(string id) => consumedSnapshots.TryGetValue(id, out var snapshot) ? snapshot : null;
	private readonly OperationReceipts<ReceiveDeleteResult> receiveDeletes = new(100, "Receive-and-delete operation ID was already used for a different request.", "The receive-and-delete receipt limit is reached. Reconnect after reviewing results.");
	private readonly Dictionary<string, (ReceivedMessage Message, ReadOnlyMemory<byte> Body, MessageSummary Summary)> consumedSnapshots = [];

	public async Task<ReceiveDeleteResult> ExecuteAsync(ReceiveDeleteMessages request, string fingerprint, Func<ReceiveDeleteProgress, Task> emit, CancellationToken cancellation)
	{
		var operationId = request.Id;
		if (CheckRequest(operationId, fingerprint) is { } previous)
			return previous;
		var target = request.Target;
		target.Validate(peek: true);
		var subQueue = request.SubQueue;
		var sessionId = request.SessionId;
		var maxMessages = request.MaxMessages;
		var maxSeconds = request.MaxSeconds;
		MaintenancePolicies.ValidateSubQueue(subQueue);
		var path = target.Kind == "queue" ? target.Name : $"{target.TopicName}/Subscriptions/{target.Name}";
		var expected = $"RECEIVE AND DELETE {namespaceName}/{path}/{subQueue}" + (sessionId.Length > 0 ? $" session={sessionId}" : "");
		if (sessionId.Length > 128 || (subQueue != "active" && sessionId.Length > 0) || maxMessages is < 1 or > 100 || maxSeconds is < 1 or > 600 ||
			request.Confirmation != expected)
			throw new OperationException(OperationFailure.InvalidInput, "Confirm the exact source and session. Use a message limit of 1–100 and a time limit of 1–600 seconds. Dead-letter sources do not accept a session filter.");
		if (hasInteractiveReceiver())
			throw new OperationException(OperationFailure.OperationBlocked, "Close the current message or session receiver before receive-and-delete. Held messages will not be settled.");

		var clock = Stopwatch.StartNew();
		using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(maxSeconds));
		using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation, deadline.Token);
		var token = lifetime.Token;
		IMessageReceiver? receiver = null;
		List<MessageSummary> items = [];
		var received = 0;
		var retained = 0L;
		var receiving = false;
		var uncertain = false;
		var status = "completed";
		var reason = "no-available-messages";
		string? detail = null, cleanupWarning = null;
		long lastProgress = -1000;
		async Task Progress(string phase, bool force = false)
		{
			if (!force && clock.ElapsedMilliseconds - lastProgress < 250)
				return;
			lastProgress = clock.ElapsedMilliseconds;
			// Reporting failures must not erase a known destructive result or trigger a retry.
			try
			{
				await emit(new ReceiveDeleteProgress(operationId, received, maxMessages, clock.ElapsedMilliseconds, phase));
			}
			catch { }
		}
		try
		{
			await Progress("opening", true);
			token.ThrowIfCancellationRequested();
			var entity = await gateway!.GetEntityAsync(target, token);
			if (subQueue == "active" && entity.Entity.RequiresSession == true && sessionId.Length == 0)
				throw new OperationException(OperationFailure.InvalidInput, "Enter a session ID for this session-enabled entity.");
			if (subQueue == "active" && entity.Entity.RequiresSession == false && sessionId.Length > 0)
				throw new OperationException(OperationFailure.InvalidInput, "This entity does not use sessions. Clear the session ID.");
			receiver = await gateway.OpenReceiveDeleteReceiverAsync(target, subQueue, sessionId, token);
			token.ThrowIfCancellationRequested();
			consumedSnapshots.Clear(); // Only an accepted new run replaces the previous volatile bodies.
			while (received < maxMessages)
			{
				token.ThrowIfCancellationRequested();
				if (receiver.SessionLockedUntil is DateTimeOffset until && until < DateTimeOffset.UtcNow.AddSeconds(15))
					await receiver.RenewSessionLockAsync(token);
				var remaining = TimeSpan.FromSeconds(maxSeconds) - clock.Elapsed;
				if (remaining <= TimeSpan.Zero)
				{
					status = "limited";
					reason = "time-limit";
					break;
				}
				await Progress("receiving", received == 0);
				token.ThrowIfCancellationRequested();
				receiving = true;
				var batch = await receiver.ReceiveAsync(1, remaining < TimeSpan.FromSeconds(2) ? remaining : TimeSpan.FromSeconds(2), token);
				receiving = false;
				// ReceiveAndDelete consumes at transfer time. Preserve returned messages even if cancellation raced the return.
				received += batch.Count;
				foreach (var message in batch)
				{
					ReadOnlyMemory<byte> body = ReadOnlyMemory<byte>.Empty;
					string? warning = null;
					try
					{
						body = message.Body.ToMemory();
					}
					catch (NotSupportedException) { warning = "Consumed message has an unsupported AMQP body; no inspectable copy was retained."; }
					if (retained + body.Length > SnapshotBudget)
						warning = "Consumed message exceeds the remaining 64 MiB inspection budget; its body was not retained.";
					var id = warning is null ? Guid.NewGuid().ToString() : null;
					static string? Bound(string? value, int count) => value is not null && value.Length > count ? value[..count] : value;
					var summary = Summary(message, id, body.Length, warning) with
					{
						MessageId = Bound(message.MessageId, 128),
						Subject = Bound(message.Subject, 512),
						ContentType = Bound(message.ContentType, 128),
						SessionId = Bound(message.SessionId, 128)
					};
					items.Add(summary);
					if (id is not null)
					{
						consumedSnapshots.Add(id, (message, body, summary));
						retained += body.Length;
					}
					if (warning is not null || retained >= SnapshotBudget)
					{
						status = "limited";
						reason = "inspection-limit";
					}
				}
				await Progress("receiving", true);
				if (batch.Count > 1)
					throw new OperationException(OperationFailure.ReceiverContractViolation, "The receiver exceeded the requested batch size. No further receive was issued.");
				if (reason == "inspection-limit")
					break;
				if (received >= maxMessages)
				{
					status = "limited";
					reason = "message-limit";
					break;
				}
				token.ThrowIfCancellationRequested();
				if (batch.Count == 0)
					break;
			}
		}
		catch (Exception error)
		{
			var failure = failures.Classify(error, MaintenanceOperation.ReceiveDelete);
			var rejected = failure.IsRejected;
			uncertain = receiving && !rejected;
			if (uncertain)
			{
				status = "unknown";
				reason = cancellation.IsCancellationRequested ? "cancelled" : deadline.IsCancellationRequested ? "time-limit" : "error";
				detail = "The interrupted receive may have consumed additional messages without returning them. The total lost is unknown. Nothing was retried.";
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
				detail = failure.SafeDetail ?? "Receive-and-delete stopped after an access or broker error. Nothing was retried.";
			}
		}
		finally
		{
			await Progress("closing", true);
			if (receiver is not null)
				try
				{
					await receiver.DisposeAsync();
				}
				catch { cleanupWarning = "Receiver cleanup could not be confirmed. Review the source before another run."; uncertain = true; status = "unknown"; }
		}
		var stop = reason switch
		{
			"message-limit" => "Message limit reached.",
			"time-limit" => "Time limit reached.",
			"inspection-limit" => "Local inspection limit reached. Review warnings before continuing.",
			"cancelled" => "Cancelled. Consumed messages cannot be restored.",
			"no-available-messages" => "No further messages were returned in the wait window; the source is not guaranteed empty.",
			_ => detail ?? "Receive-and-delete stopped."
		};
		if (uncertain && detail is not null && reason != "error")
			stop += " " + detail;
		var result = new ReceiveDeleteResult(operationId, target, subQueue, sessionId, status, reason, received, uncertain,
			clock.ElapsedMilliseconds, items.AsReadOnly(), $"{received} {(received == 1 ? "message" : "messages")} returned and permanently consumed. {stop}", cleanupWarning);
		receiveDeletes.Add(operationId, fingerprint, result);
		await Progress("finished", true);
		return result;
	}
}
