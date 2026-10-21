using System.Diagnostics;
using MsgCommander.Application.Common;
using MsgCommander.Application.EventHubs.Gateways;
using MsgCommander.Application.EventHubs.Connections;
using MsgCommander.Contracts.EventHubs.Messaging;

namespace MsgCommander.Application.EventHubs.Messaging;

public sealed class EventHubSendService(IEventHubsGateway gateway, EventHubResourceCleanup cleanup, IEventHubsFailureClassifier failures)
{
	private readonly Dictionary<string, (string Fingerprint, EventHubSendResult Result)> sends = [];
	public EventHubSendResult? GetResult(string id) => sends.TryGetValue(id, out var prior) ? prior.Result : null;
	public EventHubSendResult? CheckRequest(string id, string stamp)
	{
		if (!Guid.TryParse(id, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid send operation ID.");
		if (sends.TryGetValue(id, out var prior))
		{
			if (prior.Fingerprint != stamp)
				throw new OperationException(OperationFailure.InvalidInput, "Send ID already belongs to another request.");
			return prior.Result;
		}
		if (sends.Count >= 100)
			throw new OperationException(OperationFailure.OperationBlocked, "Send receipt limit reached. Review results before reconnecting.");
		if (cleanup.HasFailures)
			throw new OperationException(OperationFailure.OperationBlocked, "Disconnect before sending because client cleanup could not be confirmed.");
		return null;
	}
	public void Clear() => sends.Clear();
	public async Task<EventHubSendResult> ExecuteAsync(EventHubSendRequest request, string stamp, Func<EventHubSendProgress, Task> emit, CancellationToken cancellation)
	{
		var id = request.Id;
		if (CheckRequest(id, stamp) is { } previous)
			return previous;
		var hub = EventHubsValidation.Name(request.HubName);
		var routing = request.Routing;
		EventRoutingRules.Validate(routing);
		var drafts = request.Drafts.ToArray();
		if (drafts.Length is < 1 or > 20)
			throw new OperationException(OperationFailure.InvalidInput, "Use 1–20 drafts and at most 512 KiB of serialized drafts.");
		var repeat = request.Repetitions;
		var batchSize = request.BatchSize;
		var seconds = request.MaxSeconds;
		var delay = request.DelayMs;
		if (repeat is < 1 or > 1000 || drafts.Length * repeat > 1000 || batchSize is < 1 or > 100 || seconds is < 1 or > 300 || delay is < 0 or > 1000 || !request.Acknowledged)
			throw new OperationException(OperationFailure.InvalidInput, "Acknowledge sending, use at most 1000 events, 1–100 per batch, 1–300 seconds and 0–1000 ms delay.");
		var total = drafts.Length * repeat;
		var sent = 0;
		var batches = 0;
		var uncertain = 0;
		int? lastFirst = null;
		var lastCount = 0;
		var status = "completed";
		var reason = "count";
		string? detail = null, warning = null;
		var writing = false;
		var clock = Stopwatch.StartNew();
		long lastProgress = -1000;
		var statistics = new EventStatisticsCounter();
		using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(seconds));
		using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation, deadline.Token);
		var token = lifetime.Token;
		IEventHubSender? sender = null;
		async Task Progress(string phase, bool force = false)
		{
			if (!force && clock.ElapsedMilliseconds - lastProgress < 250)
				return;
			lastProgress = clock.ElapsedMilliseconds;
			try
			{
				await emit(new EventHubSendProgress(id, total, sent, batches, uncertain, clock.ElapsedMilliseconds, phase, statistics.Snapshot()));
			}
			catch { }
		}
		try
		{
			await Progress("validating", true);
			token.ThrowIfCancellationRequested();
			// Validate every draft before creating any sender or dispatching a batch.
			for (var i = 0; i < drafts.Length; i++)
				OutgoingEvents.Build(drafts[i], $"{id}:{i + 1}");
			sender = gateway!.OpenSender(hub);
			// Include the longest generated ID in size preflight so later repetitions cannot grow unexpectedly.
			foreach (var draft in drafts)
			{
				token.ThrowIfCancellationRequested();
				using var check = await sender.CreateBatchAsync(routing, token);
				if (!check.TryAdd(OutgoingEvents.Build(draft, $"{id}:{total}")))
					throw new OperationException(OperationFailure.InvalidInput, "An event cannot fit in an empty broker batch. Nothing was sent.");
			}
			while (sent < total)
			{
				token.ThrowIfCancellationRequested();
				using var batch = await sender.CreateBatchAsync(routing, token);
				var count = 0;
				var bodySizes = new List<int>();
				while (sent + count < total && count < batchSize)
				{
					token.ThrowIfCancellationRequested();
					var next = OutgoingEvents.Build(drafts[(sent + count) % drafts.Length], $"{id}:{sent + count + 1}");
					if (!batch.TryAdd(next))
					{
						if (count == 0)
							throw new OperationException(OperationFailure.InvalidInput, "An event no longer fits the broker batch. Review confirmed results before another send.");
						break;
					}
					bodySizes.Add(next.EventBody.ToMemory().Length);
					count++;
				}
				await Progress("sending", batches == 0);
				token.ThrowIfCancellationRequested();
				await statistics.Measure(async () => { await batch.SendAsync(() => { writing = true; lastFirst = sent + 1; lastCount = count; }, token); return true; });
				foreach (var size in bodySizes)
					statistics.Body(size);
				writing = false;
				sent += count;
				batches++;
				await Progress("pacing");
				if (sent >= total)
					break;
				token.ThrowIfCancellationRequested();
				if (delay > 0)
					await Task.Delay(delay, token);
			}
		}
		catch (Exception error)
		{
			var rejected = failures.Classify(error, EventFailureOperation.Send).Rejected;
			uncertain = writing && !rejected ? lastCount : 0;
			reason = cancellation.IsCancellationRequested ? "cancelled" : deadline.IsCancellationRequested ? "time" : "error";
			if (uncertain > 0)
				status = "unknown";
			else if (error is OperationCanceledException && token.IsCancellationRequested)
				status = cancellation.IsCancellationRequested ? "cancelled" : "limited";
			else
			{
				status = "failed";
				reason = "error";
			}
			detail = error is OperationException protocol ? protocol.Message : "The send failed. Check the hub, routing and Send/Data Sender permission. No batch was retried.";
		}
		finally
		{
			await Progress("closing", true);
			if (sender is not null && !await cleanup.CloseAsync(sender))
			{
				warning = "Sender cleanup could not be confirmed. Disconnect before another operation; a backend restart may be required.";
				if (status != "unknown")
					status = "failed";
			}
		}
		var stop = reason switch
		{
			"count" => "Event target reached.",
			"time" => "Time limit reached.",
			"cancelled" => "Cancelled.",
			_ => detail
		};
		var summary = $"{sent} events confirmed in {batches} batches. {stop}" + (uncertain > 0 ? $" The last batch of {uncertain} events may have been accepted. Nothing was retried." : "");
		var result = new EventHubSendResult(id, hub, routing, drafts.Length, repeat, total, batchSize, seconds, delay, sent, batches, uncertain, clock.ElapsedMilliseconds, status, reason, lastFirst, lastCount, summary, warning, statistics.Snapshot());
		sends.Add(id, (stamp, result));
		await Progress("finished", true);
		return result;
	}
}
