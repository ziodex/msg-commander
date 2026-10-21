using MsgCommander.Application.Common;
using MsgCommander.Contracts.EventHubs.Messaging;

namespace MsgCommander.Application.EventHubs.Messaging;

public sealed class EventSnapshotStore
{
	public const int Budget = 64 * 1024 * 1024;
	internal readonly Dictionary<string, (EventSummary Summary, ReadOnlyMemory<byte> Body, EventDetails Details)> Snapshots = [];
	internal readonly Dictionary<string, (string Namespace, string Hub, string Group, string Partition)> Origins = [];
	public void Clear()
	{
		Snapshots.Clear();
		Origins.Clear();
	}
	private (EventSummary Summary, ReadOnlyMemory<byte> Body, EventDetails Details) Snapshot(string id) => Snapshots.TryGetValue(id, out var value)
		? value : throw new OperationException(OperationFailure.DeferredMessageUnavailable, "Event snapshot expired. Only the latest read's bodies remain available; read explicitly again if needed.");
	public EventDetails Inspect(string id) => Snapshot(id).Details;
	public EventExport Export(string id)
	{
		var snapshot = Snapshot(id);
		var origin = Origins[id];
		return new(origin.Namespace, origin.Hub, origin.Group, origin.Partition, snapshot.Details);
	}
	public EventBodyChunk Body(string id, int offset, int count)
	{
		var value = Snapshot(id).Body;
		if (offset < 0 || offset > value.Length || count is < 1 or > 65536)
			throw new OperationException(OperationFailure.InvalidInput, "Invalid event body range.");
		var length = Math.Min(count, value.Length - offset);
		return new(Convert.ToBase64String(value.Slice(offset, length).Span), offset, value.Length, offset + length < value.Length ? (int?)(offset + length) : null);
	}
}
