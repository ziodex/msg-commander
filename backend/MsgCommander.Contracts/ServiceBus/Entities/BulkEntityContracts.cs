using System.Text.Json.Serialization;

namespace MsgCommander.Contracts.ServiceBus.Entities;

public sealed record BulkEntityAction(string Kind, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Status = null);
public sealed record BulkEntityPreviewItem(EntityTarget Target, string CurrentStatus, IReadOnlyList<EntityTarget> Subscriptions);
public sealed record BulkEntityPlan(string PlanId, string Namespace, BulkEntityAction Action, IReadOnlyList<BulkEntityPreviewItem> Items,
	int AffectedCount, int MaxSeconds, string ExpiresAt, string Confirmation);
public sealed record BulkEntityRow(EntityTarget Target, string Status, string Summary);
public sealed record BulkEntityResult(string OperationId, BulkEntityPlan Plan, string Status, IReadOnlyList<BulkEntityRow> Items,
	int Confirmed, int Uncertain, long ElapsedMs, string Summary);
public sealed record BulkEntityPreviewRequest(IReadOnlyList<EntityTarget>? Targets, BulkEntityAction? Action, int MaxSeconds);
public sealed record BulkEntityExecution(string Id, string PlanId, string Confirmation);
public sealed record BulkEntityProgress(string OperationId, IReadOnlyList<BulkEntityRow> Items, int? ActiveIndex, string Phase,
	int Confirmed, int Uncertain, long ElapsedMs)
{
	public string Type => "bulk-entity-progress";
}
