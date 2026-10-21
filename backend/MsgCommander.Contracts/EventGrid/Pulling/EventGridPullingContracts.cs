using MsgCommander.Contracts.EventGrid.Browsing;

namespace MsgCommander.Contracts.EventGrid.Pulling;

public sealed record EventGridReceive(string Id, string ConnectionId, EventGridTarget Target, int MaxEvents, int BatchSize, int MaxWaitSeconds, int MaxSeconds, bool Acknowledged);
public sealed record EventGridSettle(string Id, string ConnectionId, EventGridTarget Target, string Action, IReadOnlyList<string> Handles, int ReleaseDelaySeconds, bool Acknowledged);
public sealed record EventGridReceived(string Handle, EventGridTarget Target, string EventId, string Source, string EventType, string Subject, int DeliveryCount, string ReceivedAt, string EstimatedLockedUntil, string State, int Bytes);
public sealed record EventGridEventInspection(EventGridReceived Item, string EventJson, bool Truncated);
public sealed record EventGridSettlementResult(string Handle, string Status, string? ErrorCode);
public sealed record EventGridPullOutcome(string OperationId, EventGridTarget Target, string Action, int Requested, int Confirmed, int Failed, int Uncertain, long ElapsedMs, string Status, string Reason, string Summary, IReadOnlyList<string> Handles, IReadOnlyList<EventGridSettlementResult> Results);
public sealed record EventGridPullProgress(string OperationId, string Action, int Requested, int Confirmed, int Failed, int Uncertain, long ElapsedMs, string Phase)
{
	public string Type => "event-grid-pull-progress";
}
