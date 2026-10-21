using System.Diagnostics;
using MsgCommander.Application.Common;
using MsgCommander.Application.EventGrid.Gateways;
using MsgCommander.Contracts.EventGrid.Publishing;

namespace MsgCommander.Application.EventGrid.Publishing;

public sealed class EventGridPublishingService(IEventGridGateway gateway, IEventGridFailureClassifier failures)
{
	public void Clear() => publishes.Clear();
	public EventGridPublishOutcome? GetResult(string id)
	{
		if (!Guid.TryParse(id, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid publish receipt ID.");
		return publishes.TryGetValue(id, out var saved) ? saved.Result : null;
	}
	private readonly Dictionary<string, (string Stamp, EventGridPublishOutcome Result)> publishes = [];
	public async Task<EventGridPublishOutcome> ExecuteAsync(EventGridPublish p, string stamp, Func<EventGridPublishProgress, Task> emit, CancellationToken cancellation)
	{
		var events = OutgoingCloudEvents.Validate(p);
		if (publishes.TryGetValue(p.Id, out var prior))
		{
			if (prior.Stamp != stamp)
				throw new OperationException(OperationFailure.InvalidInput, "Publish ID belongs to a different request.");
			return prior.Result;
		}
		if (publishes.Count >= 100)
			throw new OperationException(OperationFailure.OperationBlocked, "Publish receipt limit reached. Review results before reconnecting.");
		var sent = 0;
		var batches = 0;
		var uncertain = 0;
		var writing = false;
		int? first = null;
		var count = 0;
		var status = "completed";
		var reason = "count";
		var clock = Stopwatch.StartNew();
		using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(p.MaxSeconds));
		using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation, deadline.Token);
		var token = lifetime.Token;
		async Task Progress(string phase)
		{
			try
			{
				await emit(new EventGridPublishProgress(p.Id, events.Length, sent, batches, uncertain, clock.ElapsedMilliseconds, phase));
			}
			catch
			{
				// Progress delivery cannot change a publishing receipt.
			}
		}
		try
		{
			await Progress("validating");
			token.ThrowIfCancellationRequested();
			while (sent < events.Length)
			{
				token.ThrowIfCancellationRequested();
				var next = events.Skip(sent).Take(p.Mode == "single" ? 1 : p.BatchSize).ToArray();
				var body = p.Mode == "single" ? next[0] : OutgoingCloudEvents.Batch(next);
				if (body.Length > 1048576)
					throw new OperationException(OperationFailure.InvalidInput, "CloudEvents request exceeds 1 MiB. Nothing in this batch was sent.");
				await Progress("sending");
				token.ThrowIfCancellationRequested();
				await gateway!.PublishAsync(p.TopicName, p.Mode, body, () => { writing = true; first = sent + 1; count = next.Length; }, token);
				writing = false;
				sent += next.Length;
				batches++;
				await Progress("pacing");
				if (sent < events.Length && p.DelayMs > 0)
					await Task.Delay(p.DelayMs, token);
			}
		}
		catch (Exception e)
		{
			var rejected = failures.Classify(e, EventGridFailureOperation.Publish).Rejected;
			uncertain = writing && !rejected ? count : 0;
			reason = cancellation.IsCancellationRequested ? "cancelled" : deadline.IsCancellationRequested ? "time" : "error";
			status = uncertain > 0 ? "unknown" : e is OperationCanceledException && token.IsCancellationRequested ? (reason == "cancelled" ? "cancelled" : "limited") : "failed";
			if (status == "failed")
				reason = "error";
		}
		var summary = $"{sent}/{events.Length} events confirmed by Event Grid in {batches} request{(batches == 1 ? "" : "s")}. " + (status switch
		{
			"completed" => "Publishing completed; consumer delivery is separate.",
			"limited" => "Time limit reached.",
			"cancelled" => "Cancelled before another request.",
			"unknown" => $"Events {first}–{first + count - 1} may have been accepted. Review before another send.",
			_ => "Publishing failed. Check the topic, connectivity and EventGrid Data Sender permission."
		}) + " Nothing was retried.";
		var result = new EventGridPublishOutcome(p.Id, p.TopicName, events.Length, sent, batches, uncertain, clock.ElapsedMilliseconds, status, reason, first, count, summary);
		publishes.Add(p.Id, (stamp, result));
		await Progress("finished");
		return result;
	}
}
