using Azure;
using MsgCommander.Host;

sealed partial class FixtureGateway
{
	public async Task<RuntimePage> ListRuntimeAsync(string kind, string? topicName, string? continuationToken, CancellationToken cancellation)
	{
		if (topicName == "runtime-denied")
			throw new RequestFailedException(403, "SECRET denied runtime counts");
		if (topicName == "runtime-slow")
			await Task.Delay(10000, cancellation);
		var page = await ListAsync(kind, topicName, continuationToken, cancellation);
		List<RuntimeEntity> items = [];
		foreach (var entity in page.Items)
		{
			if (entity.Target.Name == "deleted")
				continue; // A disappeared entity isn't in the runtime feed.
			var target = entity.Target;
			var bucket = messages.TryGetValue(Key(target), out var stored) ? stored : [];
			var active = bucket.Count(m => MatchesSubqueue(m, "active") && m.State != "scheduled");
			var transferDlq = bucket.Count(m => MatchesSubqueue(m, "transfer-dead-letter"));
			var dlq = bucket.Count(m => MatchesSubqueue(m, "dead-letter"));
			var scheduled = bucket.Count(m => m.State == "scheduled");
			if (!messages.ContainsKey(Key(target)) && target.Name != "empty")
			{
				active = 2;
				dlq = 1;
			}
			var counts = target.Kind == "topic" ? new EntityCounts(Scheduled: "5", SizeBytes: "0") : new EntityCounts(
				Active: target.Name == "runtime-exact" ? "9007199254740993" : active.ToString(), DeadLetter: dlq.ToString(), Scheduled: target.Kind == "queue" ? scheduled.ToString() : null,
				Transfer: "0", TransferDeadLetter: transferDlq.ToString(), Total: (target.Name == "runtime-exact" ? 9007199254740993L + dlq + scheduled + transferDlq : active + dlq + scheduled + transferDlq).ToString(), SizeBytes: target.Kind == "queue" ? "0" : null);
			items.Add(new(target, counts));
		}
		return new(items, page.ContinuationToken, MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow));
	}
}
