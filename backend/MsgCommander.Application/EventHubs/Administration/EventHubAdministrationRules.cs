using MsgCommander.Application.Common;
using MsgCommander.Contracts.EventHubs.Administration;
using MsgCommander.Domain.EventHubs;

namespace MsgCommander.Application.EventHubs.Administration;

public static class EventHubAdministrationRules
{
	public static EventHubDefinition Definition(EventHubSettings settings) => DomainValidation.Read(() => EventHubDefinition.Create(new(
		settings.PartitionCount, settings.Status, settings.CleanupPolicy, settings.RetentionHours,
		settings.TombstoneHours, settings.MinCompactionLagMinutes, settings.UserMetadata)));

	public static void ValidateUpdate(EventHubSettings settings, bool creating, long? existingPartitions, string existingCleanupPolicy, EventAdminContext context)
	{
		settings.Validate();
		DomainValidation.Check(() => Definition(settings).EnsureCanApply(context.Tier, creating, existingPartitions,
			existingCleanupPolicy, settings.Capture.GetProperty("mode").GetString()!));
	}
}
