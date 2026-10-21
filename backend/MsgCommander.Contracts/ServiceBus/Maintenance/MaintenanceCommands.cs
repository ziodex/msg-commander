using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.ServiceBus.Entities;

namespace MsgCommander.Contracts.ServiceBus.Maintenance;

public sealed record PurgeCutoffInput(bool Supplied, string? UtcValue);
public sealed record PurgeMessages(string Id, EntityTarget Target, string SubQueue, int MaxMessages, int MaxSeconds, string Confirmation, PurgeCutoffInput Cutoff);
public sealed record ReceiveDeleteMessages(string Id, EntityTarget Target, string SubQueue, string SessionId, int MaxMessages, int MaxSeconds, string Confirmation);
public sealed record PreviewBulkPurge(IReadOnlyList<BulkPurgeTarget>? Targets, int MaxPerTarget, int MaxTotal, int MaxSeconds, PurgeCutoffInput Cutoff);
public sealed record ExecuteBulkPurge(string Id, string PlanId, string Confirmation, bool ContainsCutoffOverride);
public sealed record RecoveryDestination(string? ProfileId, string? Namespace, ConnectionProfile? Profile, bool AcknowledgeNonAtomic)
{
	public override string ToString() => "Recovery destination (credentials omitted)";
}
public sealed record ResendDeadLetters(string Id, EntityTarget Source, string SubQueue, EntityTarget Destination,
	string Mode, string IdPolicy, int MaxMessages, int MaxSeconds, RecoveryDestination? CrossNamespace);
