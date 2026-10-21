using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.EventHubs;

public sealed record EventHubProperties(int PartitionCount, string Status, string CleanupPolicy, int? RetentionHours,
	int? TombstoneHours, int? MinCompactionLagMinutes, string UserMetadata);

public sealed class EventHubDefinition
{
	public EventHubProperties Properties
	{
		get;
	}
	private EventHubDefinition(EventHubProperties properties) => Properties = properties;

	public static EventHubDefinition Create(EventHubProperties value)
	{
		if (value.PartitionCount is < 1 or > 1024 || value.Status is not ("Active" or "Disabled" or "SendDisabled" or "ReceiveDisabled") ||
			value.CleanupPolicy is not ("Delete" or "Compact" or "DeleteOrCompact") || value.RetentionHours is < 1 or > 2160 ||
			value.TombstoneHours is < 1 or > 2160 || value.MinCompactionLagMinutes is < 0 || value.UserMetadata is null || value.UserMetadata.Length > 1024 ||
			((value.CleanupPolicy == "Compact") != (value.RetentionHours is null)) ||
			(value.CleanupPolicy == "Delete" && (value.TombstoneHours is not null || value.MinCompactionLagMinutes is not null)))
			throw new DomainRuleException("Check partition count, status, retention/compaction settings and metadata limits.");
		return new(value);
	}

	public void EnsureCanApply(string tier, bool creating, long? existingPartitions, string existingCleanupPolicy, string captureMode)
	{
		var limit = tier switch
		{
			"Basic" or "Standard" => 32,
			"Premium" => 100,
			_ => 1024
		};
		var retentionLimit = tier switch
		{
			"Basic" => 24,
			"Standard" => 168,
			_ => 2160
		};
		if (Properties.PartitionCount > limit || Properties.RetentionHours > retentionLimit)
			throw new DomainRuleException("Partition count or retention exceeds this namespace tier's limit.");
		if (tier == "Basic" && (Properties.CleanupPolicy != "Delete" || captureMode == "configure"))
			throw new DomainRuleException("Basic namespaces do not support Capture or log compaction.");
		if (!creating && Properties.CleanupPolicy != existingCleanupPolicy)
			throw new DomainRuleException("Cleanup policy cannot be changed after hub creation.");
		if (!creating && existingPartitions != Properties.PartitionCount &&
			(Properties.PartitionCount < existingPartitions || tier is not ("Premium" or "Dedicated")))
			throw new DomainRuleException("Partitions can only be increased in Premium or Dedicated namespaces. Reducing partitions is not supported.");
	}
}
