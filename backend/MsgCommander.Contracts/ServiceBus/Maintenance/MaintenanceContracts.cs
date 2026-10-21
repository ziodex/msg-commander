using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Messages;
using System.Text.Json.Serialization;

namespace MsgCommander.Contracts.ServiceBus.Maintenance;

public sealed record PurgeResult(string OperationId, EntityTarget Target, string SubQueue, string Status, string Reason,
	int Received, int Completed, int Uncertain, long ElapsedMs, string Summary, string? CleanupWarning, string? BeforeEnqueueTime, int Skipped);

public sealed record PurgeProgress(string OperationId, int Received, int Completed, int Uncertain, int MaxMessages, long ElapsedMs, string Phase, string? BeforeEnqueueTime, int Skipped)
{
	public string Type => "purge-progress";
}


public sealed record ReceiveDeleteResult(string OperationId, EntityTarget Target, string SubQueue, string SessionId,
	string Status, string Reason, int Received, bool Uncertain, long ElapsedMs, IReadOnlyList<MessageSummary> Items,
	string Summary, string? CleanupWarning);
public sealed record ReceiveDeleteProgress(string OperationId, int Received, int MaxMessages, long ElapsedMs, string Phase)
{
	public string Type => "receive-delete-progress";
}


public sealed record BulkPurgeTarget(EntityTarget Target, string SubQueue);
public sealed record BulkPurgePreviewItem(EntityTarget Target, string SubQueue, string? EstimatedCount);
public sealed record BulkPurgePlan(string PlanId, string Namespace, IReadOnlyList<BulkPurgePreviewItem> Items,
	int MaxPerTarget, int MaxTotal, int MaxSeconds, string ExpiresAt, string Confirmation, string? BeforeEnqueueTime);
public sealed record BulkPurgeItem(EntityTarget Target, string SubQueue, PurgeResult? Result);
public sealed record BulkPurgeResult(string OperationId, BulkPurgePlan Plan, string Status, string Reason,
	IReadOnlyList<BulkPurgeItem> Items, int Received, int Completed, int Uncertain, long ElapsedMs, string Summary, int Skipped);


public sealed record ResendTransfer(string SourceSequenceNumber, string? OriginalMessageId, string OutgoingMessageId, string Send, string Source);
public sealed record ResendResult(string OperationId, EntityTarget Source, string SubQueue, EntityTarget Destination, string Mode, string IdPolicy,
	string Status, string Reason, int Examined, int Sent, int Removed, int Uncertain, long ElapsedMs,
	string? SourceSequenceNumber, string? OutgoingMessageId, string Summary, string? CleanupWarning,
	string SourceNamespace, string DestinationNamespace, bool CrossNamespace, int CopiedNotRemoved, IReadOnlyList<ResendTransfer> Transfers);


public sealed record BulkPurgeProgress(string OperationId, int? ActiveIndex, PurgeProgress? Current,
	IReadOnlyList<BulkPurgeItem> Items, int Received, int Completed, int Uncertain, long ElapsedMs, string Phase, int Skipped)
{
	public string Type => "bulk-purge-progress";
}
public sealed record ResendProgress(string OperationId, int Examined, int Sent, int Removed, int Uncertain,
	int MaxMessages, long ElapsedMs, string Phase, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? CopiedNotRemoved = null)
{
	public string Type => "resend-progress";
}
