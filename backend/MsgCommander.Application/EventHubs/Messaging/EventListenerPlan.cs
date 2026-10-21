using System.Globalization;
using MsgCommander.Application.Common;
using MsgCommander.Application.EventHubs.Gateways;
using MsgCommander.Contracts.EventHubs.Browsing;
using MsgCommander.Contracts.EventHubs.Messaging;

namespace MsgCommander.Application.EventHubs.Messaging;

internal sealed class EventListenerPartition(string id)
{
	public string Id { get; } = id;
	public string Status = "queued", Floor = "0";
	public int Received;
	public long Bytes;
	public string? LastSequence, Error;
	public EventPositionSpec Position = new("earliest");
	public ListenerPartition Progress() => new(Id, Status, Received, Bytes, LastSequence, Error);
}

// Resolves fixed starting positions before any receiver opens. Failed preflight never clears snapshots.
internal sealed class EventListenerPlan
{
	public EventHubInfo? Hub
	{
		get; private set;
	}
	public IReadOnlyList<EventListenerPartition> Partitions { get; private set; } = [];
	public bool Ready
	{
		get; private set;
	}
	internal static EventPositionSpec SequencePosition(string value, bool inclusive) => new("sequence", value, inclusive);
	private static long SequenceValue(string value) => long.TryParse(value, NumberStyles.None,
		CultureInfo.InvariantCulture, out var number) && number >= 0 ? number :
		throw new OperationException(OperationFailure.InvalidInput, "Invalid checkpoint sequence.");

	public static EventCheckpoint? ValidateStart(EventListenRequest request, EventHubsConnection connection)
	{
		var kind = request.Start.Kind;
		if (kind != "checkpoint")
		{
			if (kind is not ("earliest" or "latest" or "time"))
				throw new OperationException(OperationFailure.InvalidInput, "Choose earliest, latest, time or a local checkpoint.");
			EventHubsValidation.Position(new(kind, request.Start.Value));
			return null;
		}
		var checkpoint = request.Start.Checkpoint ??
			throw new OperationException(OperationFailure.InvalidInput, "Missing checkpoint.");
		if (!DocumentFormats.Matches(checkpoint.Format, "msg-commander/event-checkpoints") || checkpoint.Version != 1 ||
			checkpoint.Partitions is null || checkpoint.Partitions.Count is < 1 or > 1024 ||
			checkpoint.Partitions.Select(p => p.PartitionId).Distinct().Count() != checkpoint.Partitions.Count ||
			!DateTimeOffset.TryParse(checkpoint.HubCreatedAt, out _) || !DateTimeOffset.TryParse(checkpoint.SavedAt, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid or unsupported local checkpoint file.");
		EventHubsValidation.Name(checkpoint.HubName);
		EventHubsValidation.Name(checkpoint.ConsumerGroup, true);
		foreach (var partition in checkpoint.Partitions)
		{
			EventHubsValidation.Partition(partition.PartitionId);
			if (partition.PartitionId.Length > 10)
				throw new OperationException(OperationFailure.InvalidInput, "Invalid checkpoint partition.");
			SequenceValue(partition.RetentionFloor);
			EventHubsValidation.Position(partition.Position);
			if (partition.Position.Kind is not ("sequence" or "time"))
				throw new OperationException(OperationFailure.InvalidInput, "Checkpoint positions must be fixed sequence or time positions.");
		}
		if (!string.Equals(checkpoint.Namespace, connection.Namespace, StringComparison.OrdinalIgnoreCase) ||
			checkpoint.HubName != request.HubName || checkpoint.ConsumerGroup != request.ConsumerGroup)
			throw new OperationException(OperationFailure.InvalidInput, "Checkpoint namespace, hub and consumer group must match the listener target.");
		return checkpoint;
	}

	public async Task PrepareAsync(IEventHubsGateway gateway, EventListenRequest request,
		EventCheckpoint? checkpoint, CancellationToken cancellation)
	{
		Hub = await gateway.GetHubAsync(request.HubName, cancellation);
		if (Hub.PartitionIds.Count is < 1 or > 1024 || Hub.PartitionIds.Distinct().Count() != Hub.PartitionIds.Count ||
			Hub.PartitionIds.Any(p => p.Length > 10))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid partition discovery result.");
		if (checkpoint is not null && (checkpoint.HubCreatedAt != Hub.CreatedAt ||
			!checkpoint.Partitions.Select(p => p.PartitionId).Order().SequenceEqual(Hub.PartitionIds.Order())))
			throw new OperationException(OperationFailure.InvalidInput, "The hub was recreated or its partitions changed. Start a new listener explicitly; this checkpoint was not applied.");
		Partitions = Hub.PartitionIds.Select(p => new EventListenerPartition(EventHubsValidation.Partition(p))).ToArray();
		await Parallel.ForEachAsync(Partitions, new ParallelOptions
		{
			MaxDegreeOfParallelism = request.Concurrency,
			CancellationToken = cancellation
		}, async (partition, token) =>
		{
			var metadata = await gateway.GetPartitionAsync(request.HubName, partition.Id, token);
			partition.Floor = metadata.BeginningSequence ?? "0";
			var prior = checkpoint?.Partitions.Single(p => p.PartitionId == partition.Id);
			if (prior is not null)
			{
				ValidateRetainedPosition(prior, metadata, partition.Floor);
				partition.Position = prior.Position;
			}
			else
				partition.Position = request.Start.Kind == "time"
				? new(request.Start.Kind, request.Start.Value)
				: request.Start.Kind == "latest" && !metadata.IsEmpty && metadata.LastSequence is { } last
					? SequencePosition(last, false) : SequencePosition(partition.Floor, true);
		});
		Ready = true;
	}

	private static void ValidateRetainedPosition(EventCheckpointPartition prior, EventHubPartition metadata, string retentionFloor)
	{
		var floor = SequenceValue(retentionFloor);
		if (prior.Position.Kind != "sequence")
		{
			if (floor > SequenceValue(prior.RetentionFloor))
				throw new OperationException(OperationFailure.InvalidInput, "Retention advanced past an unconsumed time checkpoint. Choose a new starting position explicitly.");
			return;
		}
		var sequence = SequenceValue(prior.Position.Value!);
		var inclusive = prior.Position.Inclusive!.Value;
		if (!metadata.IsEmpty && (sequence < floor && (inclusive || sequence < floor - 1)) ||
			metadata.LastSequence is { } last && sequence > SequenceValue(last) || metadata.IsEmpty && sequence != 0)
			throw new OperationException(OperationFailure.InvalidInput, "Checkpoint position is outside the retained stream. Review retention or hub recreation and start from an explicit new position.");
	}
}
