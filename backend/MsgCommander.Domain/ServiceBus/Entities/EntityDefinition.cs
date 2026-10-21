using System.Text;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.ServiceBus.Entities;

public sealed record EntitySettingsDraft(
	string Status, string DefaultMessageTimeToLive, string AutoDeleteOnIdle, bool EnableBatchedOperations, string UserMetadata,
	string? LockDuration, int? MaxDeliveryCount, bool? DeadLetteringOnMessageExpiration, string? ForwardTo, string? ForwardDeadLetteredMessagesTo, bool? RequiresSession,
	long? MaxSizeInMegabytes, long? MaxMessageSizeInKilobytes, bool? RequiresDuplicateDetection, string? DuplicateDetectionHistoryTimeWindow, bool? EnablePartitioning,
	bool? SupportOrdering, bool? EnableDeadLetteringOnFilterEvaluationExceptions);

/// <summary>A validated entity definition; construction enforces kind-specific settings and forwarding rules.</summary>
public sealed class EntityDefinition
{
	public EntityAddress Address
	{
		get;
	}
	public EntitySettingsDraft Settings
	{
		get;
	}
	public EntityCreationOptions CreationOptions
	{
		get;
	}

	private EntityDefinition(EntityAddress address, EntitySettingsDraft settings)
	{
		Address = address;
		Settings = settings;
		CreationOptions = new(settings.RequiresSession, settings.RequiresDuplicateDetection, settings.EnablePartitioning);
	}

	public static EntityDefinition Create(EntityAddress address, EntitySettingsDraft value)
	{
		EntityName.Validate(address);
		if (value.Status is not ("Active" or "Disabled" or "SendDisabled" or "ReceiveDisabled") ||
			address.Kind == "topic" && value.Status == "ReceiveDisabled" || address.Kind == "subscription" && value.Status == "SendDisabled")
			throw new DomainRuleException("Choose a supported entity status.");
		EntityDuration.Parse(value.DefaultMessageTimeToLive, "unlimited");
		if (EntityDuration.Parse(value.AutoDeleteOnIdle, "disabled") < TimeSpan.FromMinutes(5))
			throw new DomainRuleException("Auto-delete must be disabled or at least five minutes.");
		if (value.UserMetadata is null || Encoding.UTF8.GetByteCount(value.UserMetadata) > 1024)
			throw new DomainRuleException("User metadata must not exceed 1024 UTF-8 bytes.");
		static void Applicable(bool applies, params object?[] fields)
		{
			if (fields.Any(field => applies ? field is null : field is not null))
				throw new DomainRuleException("Settings do not match the entity kind.");
		}
		Applicable(address.Kind != "topic", value.LockDuration, value.MaxDeliveryCount, value.DeadLetteringOnMessageExpiration, value.ForwardTo, value.ForwardDeadLetteredMessagesTo, value.RequiresSession);
		Applicable(address.Kind != "subscription", value.MaxSizeInMegabytes, value.RequiresDuplicateDetection, value.DuplicateDetectionHistoryTimeWindow, value.EnablePartitioning);
		Applicable(address.Kind == "topic", value.SupportOrdering);
		Applicable(address.Kind == "subscription", value.EnableDeadLetteringOnFilterEvaluationExceptions);
		if (address.Kind != "topic")
		{
			if (EntityDuration.Parse(value.LockDuration) > TimeSpan.FromMinutes(5) || value.MaxDeliveryCount < 1)
				throw new DomainRuleException("Lock duration must be positive and at most five minutes; delivery count must be positive.");
			foreach (var forward in new[] { value.ForwardTo!, value.ForwardDeadLetteredMessagesTo! })
			{
				if (forward.Length == 0)
					continue;
				var destination = EntityAddress.TryCreate("queue", forward);
				if (destination is null)
					throw new DomainRuleException("Select a queue or subscription for peeking; subscriptions require their topic.");
				EntityName.Validate(destination);
				if (address.Kind == "queue" && string.Equals(forward, address.Name, StringComparison.OrdinalIgnoreCase) ||
					address.Kind == "subscription" && string.Equals(forward, address.TopicName, StringComparison.OrdinalIgnoreCase))
					throw new DomainRuleException("Forwarding to this queue or a subscription's parent topic would create a loop.");
			}
		}
		if (address.Kind != "subscription")
		{
			if (value.MaxSizeInMegabytes < 1 || value.MaxSizeInMegabytes > 9007199254740991 || value.MaxMessageSizeInKilobytes is < 1 or > 9007199254740991)
				throw new DomainRuleException("Entity/message sizes must be positive safe integers; the broker enforces tier-specific limits.");
			var window = EntityDuration.Parse(value.DuplicateDetectionHistoryTimeWindow);
			if (window < TimeSpan.FromSeconds(20) || window > TimeSpan.FromDays(7))
				throw new DomainRuleException("Duplicate detection history must be between 20 seconds and seven days.");
		}
		else if (value.MaxMessageSizeInKilobytes is not null)
			throw new DomainRuleException("Subscriptions have no maximum message size setting.");
		return new(address, value);
	}
}
