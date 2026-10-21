using MsgCommander.Contracts.ServiceBus.Rules;

namespace MsgCommander.Contracts.ServiceBus.Entities;

public sealed record EntityCopySpec(EntityTarget Source, EntityTarget Destination, string Mode, bool IncludeSubscriptions);
public sealed record EntityCopyState(EntityConfiguration Configuration, string Identity);
public sealed record EntityCopyItem(EntityTarget Source, EntityTarget Destination, EntitySettings Settings, IReadOnlyList<RuleSummary> Rules);
public sealed record EntityCopyPreview(string PlanId, EntityCopySpec Spec, IReadOnlyList<EntityCopyItem> Entities, int StepCount, string ExpiresOn);
public sealed record EntityCopyStep(int Index, string Action, EntityTarget Target, string? RuleName, string Status);
public sealed record EntityCopyResult(string OperationId, string PlanId, EntityCopySpec Spec, string Status, IReadOnlyList<EntityCopyStep> Steps, string Summary, bool CanFinishRename);
public sealed record RenameSourceEntry(EntityTarget Target, string Status, EntityCounts Counts);
public sealed record RenameReview(string ReviewId, string CopyOperationId, EntityTarget Source, EntityTarget Destination, IReadOnlyList<RenameSourceEntry> Entities, IReadOnlyList<string> Blockers, string ExpiresOn);
public sealed record EntityCopyExecution(string Id, string PlanId, string Confirmation);
public sealed record RenameSourceRemoval(string Id, string ReviewId, string Confirmation);
public sealed record EntityCopyProgress(string OperationId, double Percent, string Message)
{
	public string Type => "progress";
}
