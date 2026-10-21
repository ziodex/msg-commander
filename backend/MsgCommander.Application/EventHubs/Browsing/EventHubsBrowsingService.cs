using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.EventHubs.Gateways;
using MsgCommander.Application.EventHubs.Messaging;
using MsgCommander.Contracts.EventHubs.Messaging;
using MsgCommander.Contracts.EventHubs.Browsing;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Application.EventHubs.Browsing;

public sealed class EventHubsBrowsingService(IEventHubsGateway gateway, EventHubsConnection connection)
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	private readonly Dictionary<string, (string Kind, string Hub, string Token)> cursors = [];
	public void Clear() => cursors.Clear();
	public async Task<EventHubsPage> ListAsync(string kind, string hub, string? cursor, CancellationToken cancellation)
	{
		if (kind is not ("hubs" or "groups") || (kind == "hubs" && hub.Length > 0))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid Event Hubs list scope.");
		if (kind == "groups")
			EventHubsValidation.Name(hub);
		string? token = null;
		if (cursor is not null)
		{
			if (!cursors.TryGetValue(cursor, out var saved) || saved.Kind != kind || saved.Hub != hub)
				throw new OperationException(OperationFailure.InvalidInput, "List cursor expired or belongs to another scope.");
			token = saved.Token;
		}
		if (cursors.Count >= 1000)
			throw new OperationException(OperationFailure.OperationBlocked, "Browse cursor limit reached. Reconnect to refresh.");
		var page = await gateway!.ListAsync(kind, hub, token, cancellation);
		if (page.Items.Count > 250 || JsonSerializer.SerializeToUtf8Bytes(page.Items, Json).Length > 524288)
			throw new OperationException(OperationFailure.OperationBlocked, "This management page exceeds the local display limit.");
		var next = page.ContinuationToken is null ? null : Guid.NewGuid().ToString();
		if (next is not null)
			cursors.Add(next, (kind, hub, page.ContinuationToken!));
		return page with
		{
			ContinuationToken = next
		};
	}
	public async Task<EventHubStatistics> StatisticsAsync(string name, CancellationToken cancellation)
	{
		EventHubsValidation.Name(name);
		var started = Timestamp(DateTimeOffset.UtcNow);
		using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(60));
		using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation, deadline.Token);
		var token = lifetime.Token;
		var hub = await gateway!.GetHubAsync(name, token, connection!.Access == "send");
		if (hub.PartitionIds.Count is < 1 or > 1024 || hub.PartitionIds.Distinct().Count() != hub.PartitionIds.Count)
			throw new OperationException(OperationFailure.OperationBlocked, "Invalid partition discovery result.");
		var rows = new EventPartitionSnapshot[hub.PartitionIds.Count];
		await Parallel.ForEachAsync(Enumerable.Range(0, rows.Length), new ParallelOptions { MaxDegreeOfParallelism = 8, CancellationToken = token }, async (index, ct) =>
		{
			var id = EventHubsValidation.Partition(hub.PartitionIds[index]);
			try
			{
				rows[index] = new(id, await gateway.GetPartitionAsync(name, id, ct, connection.Access == "send"), null);
			}
			catch (OperationCanceledException) { throw; }
			catch { rows[index] = new(id, null, "Partition metadata unavailable. Check permissions and connectivity, then refresh."); }
		});
		token.ThrowIfCancellationRequested();
		var result = new EventHubStatistics(hub, started, Timestamp(DateTimeOffset.UtcNow), rows);
		if (JsonSerializer.SerializeToUtf8Bytes(result, Json).Length > 524288)
			throw new OperationException(OperationFailure.OperationBlocked, "Partition statistics exceed the local display limit. Inspect partitions individually.");
		return result;
	}
}
