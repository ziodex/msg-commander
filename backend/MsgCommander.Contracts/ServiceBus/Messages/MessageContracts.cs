using MsgCommander.Contracts.Common;

namespace MsgCommander.Contracts.ServiceBus.Messages;

public sealed record MessageSummary(string? SnapshotId, string SequenceNumber, string? MessageId,
	string? Subject, string? ContentType, string EnqueuedTime, string State, int DeliveryCount,
	string? SessionId, int BodySize, string? InspectionWarning, string? ScheduledEnqueueTime = null);
public sealed record PeekPage(IReadOnlyList<MessageSummary> Items, string? NextSequenceNumber,
	string? Warning, string FetchedAt);
public sealed record MessageDetails(MessageSummary Summary, IReadOnlyList<PropertyValue> SystemProperties,
	IReadOnlyList<PropertyValue> ApplicationProperties);
public sealed record BodyChunk(string Base64, int Offset, int TotalBytes, int? NextOffset);
