using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.EventHubs.Browsing;
using System.Text.Json.Serialization;

namespace MsgCommander.Contracts.EventHubs.Messaging;

public sealed record EventHubsManagementContext(string ResourceId, string TenantId, string ClientId);
public sealed record EventPositionSpec(string Kind,
	[property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Value = null,
	[property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? Inclusive = null);
public sealed record EventListenStart(string Kind,
	[property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Value = null,
	[property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] EventCheckpoint? Checkpoint = null);
public sealed record EventHubPartition(string HubName, string PartitionId, bool IsEmpty, string? BeginningSequence, string? LastSequence, string? LastOffset, string? LastEnqueuedTime);
public sealed record EventSummary(string? SnapshotId, string SequenceNumber, string Offset, string EnqueuedTime, string? PartitionKey, int BodySize, string? Warning);
public sealed record EventDetails(EventSummary Summary, IReadOnlyList<PropertyValue> ApplicationProperties, IReadOnlyList<PropertyValue> SystemProperties, string? Warning, string? MessageId = null, string? ContentType = null, string? CorrelationId = null);
public sealed record EventBodyChunk(string Base64, int Offset, int TotalBytes, int? NextOffset);
public sealed record EventExport(string Namespace, string HubName, string ConsumerGroup, string PartitionId, EventDetails Details);
public sealed record EventHubReadResult(string OperationId, string HubName, string ConsumerGroup, string PartitionId, EventPositionSpec Position,
	string Status, string Reason, int Received, long ElapsedMs, IReadOnlyList<EventSummary> Items, string Summary, string? CleanupWarning, EventOperationStatistics? Statistics = null);
public sealed record EventHubReadProgress(string OperationId, int Received, int MaxEvents, long ElapsedMs, string Phase, EventOperationStatistics? Statistics = null)
{
	public string Type => "event-hub-read-progress";
}
public sealed record EventDraft(string BodyBase64, string ContentType, string CorrelationId, IReadOnlyList<PropertyValue> Properties);
public sealed record EventRouting(string Kind, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Value = null);
public sealed record EventHubSendResult(string OperationId, string HubName, EventRouting Routing, int DraftCount, int Repetitions, int TotalEvents,
	int BatchSize, int MaxSeconds, int DelayMs, int Confirmed, int ConfirmedBatches, int Uncertain, long ElapsedMs, string Status, string Reason,
	int? LastBatchFirstIndex, int LastBatchCount, string Summary, string? CleanupWarning, EventOperationStatistics? Statistics = null);
public sealed record EventHubSendProgress(string OperationId, int TotalEvents, int Confirmed, int ConfirmedBatches, int Uncertain, long ElapsedMs, string Phase, EventOperationStatistics? Statistics = null)
{
	public string Type => "event-hub-send-progress";
}
public sealed record EventCheckpointPartition(string PartitionId, EventPositionSpec Position, string RetentionFloor);
public sealed record EventCheckpoint(string Format, int Version, string Namespace, string HubName, string ConsumerGroup, string HubCreatedAt, string SavedAt, IReadOnlyList<EventCheckpointPartition> Partitions);
public sealed record ListenerPartition(string PartitionId, string Status, int Received, long Bytes, string? LastSequence, string? Error);
public sealed record EventListenerItem(string PartitionId, string? SnapshotId, string SequenceNumber, string Offset, string EnqueuedTime, string? PartitionKey, int BodySize, string? Warning);
public sealed record EventListenResult(string OperationId, string HubName, string ConsumerGroup, int Concurrency, int MaxEvents, int MaxSeconds, string Status, string Reason, int Received, long ElapsedMs, IReadOnlyList<ListenerPartition> Partitions, IReadOnlyList<EventListenerItem> Items, EventCheckpoint? Checkpoint, string Summary, string? CleanupWarning, EventOperationStatistics? Statistics = null);
public sealed record EventListenProgress(string OperationId, int Received, int MaxEvents, long ElapsedMs, int ActiveReceivers, string Phase, IReadOnlyList<ListenerPartition> Partitions, EventOperationStatistics? Statistics = null)
{
	public string Type => "event-hub-listen-progress";
}
public sealed record EventListenRequest(string Id, string ConnectionId, string HubName, string ConsumerGroup, EventListenStart Start, int Concurrency, int MaxEvents, int MaxSeconds, bool Acknowledged);

public sealed record EventOperationStatistics(long SuccessfulCalls, long FailedCalls, long EmptyCalls,
	double TotalCallMs, double? MinCallMs, double? MaxCallMs, long BodyEvents, long BodyBytes, int? MinBodyBytes, int? MaxBodyBytes);
public sealed record EventPartitionSnapshot(string PartitionId, EventHubPartition? Metadata, string? Error);
public sealed record EventHubStatistics(EventHubInfo Hub, string StartedAt, string CapturedAt, IReadOnlyList<EventPartitionSnapshot> Partitions);

public sealed record EventHubReadRequest(string Id, string HubName, string ConsumerGroup, string PartitionId, EventPositionSpec Position, int MaxEvents, int MaxSeconds);
public sealed record EventHubSendRequest(string Id, string HubName, EventRouting Routing, IReadOnlyList<EventDraft> Drafts, int Repetitions, int BatchSize, int MaxSeconds, int DelayMs, bool Acknowledged);
