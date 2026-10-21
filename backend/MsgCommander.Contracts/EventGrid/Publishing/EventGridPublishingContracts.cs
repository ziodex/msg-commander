
namespace MsgCommander.Contracts.EventGrid.Publishing;

public sealed record CloudEventProperty(string Name, string Type, string Value);
public sealed record CloudEventDraft(string Id, string Source, string Type, string Subject, string Time, string DataContentType, string DataSchema, string DataMode, string Data, IReadOnlyList<CloudEventProperty> Properties);
public sealed record EventGridPublish(string Id, string ConnectionId, string TopicName, string Mode, IReadOnlyList<CloudEventDraft> Drafts, int BatchSize, int MaxSeconds, int DelayMs, bool Acknowledged);
public sealed record EventGridPublishOutcome(string OperationId, string TopicName, int TotalEvents, int Confirmed, int ConfirmedBatches, int Uncertain, long ElapsedMs, string Status, string Reason, int? LastBatchFirstIndex, int LastBatchCount, string Summary);
public sealed record EventGridPublishProgress(string OperationId, int TotalEvents, int Confirmed, int ConfirmedBatches, int Uncertain, long ElapsedMs, string Phase)
{
	public string Type => "event-grid-publish-progress";
}
