using System.Security.Cryptography;
using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Domain.ServiceBus.Entities;

namespace MsgCommander.Application.ServiceBus.Entities;

public static class EntityManagement
{
	public static string Path(EntityTarget target) => target.Kind == "subscription" ? $"{target.TopicName}/Subscriptions/{target.Name}" : target.Name;
	public static EntityConfiguration Configuration(EntityTarget target, EntitySettings settings) => new(target, settings,
		Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
		{
			target,
			settings
		}))));
	public static bool Affects(EntityTarget target, EntityTarget? other) => other is not null &&
		(target.Kind == other.Kind && string.Equals(Path(target), Path(other), StringComparison.OrdinalIgnoreCase) ||
		 target.Kind == "topic" && other.Kind == "subscription" && string.Equals(target.Name, other.TopicName, StringComparison.OrdinalIgnoreCase));

	private static EntityAddress Address(EntityTarget target)
	{
		target.Validate();
		return EntityAddress.TryCreate(target.Kind, target.Name, target.TopicName)!;
	}

	public static void ValidateTarget(EntityTarget target) => DomainValidation.Check(() => EntityName.Validate(Address(target)));
	public static TimeSpan Duration(string? value, string? unlimited = null) => DomainValidation.Read(() => EntityDuration.Parse(value, unlimited));
	public static string Duration(TimeSpan value, string? unlimited = null) => EntityDuration.Format(value, unlimited);

	public static void Validate(EntityTarget target, EntitySettings value) => Prepare(target, value);
	public static EntityDefinition Prepare(EntityTarget target, EntitySettings value) => DomainValidation.Read(() =>
		EntityDefinition.Create(Address(target), new(
			value.Status, value.DefaultMessageTimeToLive, value.AutoDeleteOnIdle, value.EnableBatchedOperations, value.UserMetadata,
			value.LockDuration, value.MaxDeliveryCount, value.DeadLetteringOnMessageExpiration, value.ForwardTo, value.ForwardDeadLetteredMessagesTo, value.RequiresSession,
			value.MaxSizeInMegabytes, value.MaxMessageSizeInKilobytes, value.RequiresDuplicateDetection, value.DuplicateDetectionHistoryTimeWindow, value.EnablePartitioning,
			value.SupportOrdering, value.EnableDeadLetteringOnFilterEvaluationExceptions)));

	public static void CheckRevision(EntityConfiguration current, string? expected)
	{
		if (current.Revision != expected)
			throw new OperationException(OperationFailure.RevisionConflict, "Entity settings changed since this form was opened. Reload the settings and review your changes.");
	}

	public static void CheckImmutable(EntitySettings current, EntitySettings proposed) => DomainValidation.Check(() =>
		new EntityCreationOptions(current.RequiresSession, current.RequiresDuplicateDetection, current.EnablePartitioning).EnsureUnchanged(
			new(proposed.RequiresSession, proposed.RequiresDuplicateDetection, proposed.EnablePartitioning)));
}
