using System.Xml.Linq;
using Azure.Messaging.ServiceBus.Administration;
using static MsgCommander.Application.ServiceBus.Entities.EntityManagement;

namespace MsgCommander.Infrastructure.ServiceBus;

public sealed partial class AzureServiceBusGateway
{
	public async Task<bool> EntityExistsAsync(EntityTarget target, CancellationToken cancellation)
	{
		ValidateTarget(target);
		return target.Kind switch
		{
			"queue" => (await admin.QueueExistsAsync(target.Name, cancellation)).Value,
			"topic" => (await admin.TopicExistsAsync(target.Name, cancellation)).Value,
			_ => (await admin.SubscriptionExistsAsync(target.TopicName, target.Name, cancellation)).Value
		};
	}
	public async Task<EntityCopyState> GetEntityCopyStateAsync(EntityTarget target, CancellationToken cancellation)
	{
		ValidateTarget(target);
		EntitySettings settings;
		string xml;
		if (target.Kind == "queue")
		{
			var response = await admin.GetQueueAsync(target.Name, cancellation);
			settings = Settings(response.Value);
			xml = response.GetRawResponse().Content.ToString();
		}
		else if (target.Kind == "topic")
		{
			var response = await admin.GetTopicAsync(target.Name, cancellation);
			settings = Settings(response.Value);
			xml = response.GetRawResponse().Content.ToString();
		}
		else
		{
			var response = await admin.GetSubscriptionAsync(target.TopicName, target.Name, cancellation);
			settings = Settings(response.Value);
			xml = response.GetRawResponse().Content.ToString();
		}
		Validate(target, settings);
		var description = XDocument.Parse(xml).Descendants().Single(e => e.Name.LocalName == (target.Kind == "queue" ? "QueueDescription" : target.Kind == "topic" ? "TopicDescription" : "SubscriptionDescription"));
		// Fail closed on settings the existing editor cannot represent. Read-only broker metadata and
		// authorization rules are deliberately excluded; credential copying is never implicit.
		var allowed = new HashSet<string>(StringComparer.Ordinal) {
			"Status", "DefaultMessageTimeToLive", "AutoDeleteOnIdle", "EnableBatchedOperations", "UserMetadata",
			"CreatedAt", "UpdatedAt", "AccessedAt", "SizeInBytes", "MessageCount", "CountDetails", "SubscriptionCount", "EntityAvailabilityStatus", "SkippedUpdate"
		};
		if (target.Kind != "topic")
			allowed.UnionWith(["LockDuration", "MaxDeliveryCount", "DeadLetteringOnMessageExpiration", "ForwardTo", "ForwardDeadLetteredMessagesTo", "RequiresSession"]);
		if (target.Kind != "subscription")
			allowed.UnionWith(["MaxSizeInMegabytes", "MaxMessageSizeInKilobytes", "RequiresDuplicateDetection", "DuplicateDetectionHistoryTimeWindow", "EnablePartitioning", "AuthorizationRules"]);
		if (target.Kind == "topic")
			allowed.Add("SupportOrdering");
		if (target.Kind == "subscription")
			allowed.UnionWith(["DeadLetteringOnFilterEvaluationExceptions", "DefaultRuleDescription"]);
		var defaultFalse = new HashSet<string>(StringComparer.Ordinal) { "IsAnonymousAccessible", "EnableExpress" };
		if (target.Kind == "subscription")
			defaultFalse.Add("IsClientAffine");
		if (target.Kind == "topic")
			defaultFalse.UnionWith(["FilteringMessagesBeforePublishing", "EnableSubscriptionPartitioning"]);
		bool IsSupported(XElement e) => allowed.Contains(e.Name.LocalName)
			|| defaultFalse.Contains(e.Name.LocalName) && bool.TryParse(e.Value, out var value) && !value
			|| target.Kind == "queue" && e.Name.LocalName == "SupportOrdering" && bool.TryParse(e.Value, out var ordered) && ordered == !settings.EnablePartitioning
			|| target.Kind == "topic" && e.Name.LocalName == "ForwardTo" && string.IsNullOrWhiteSpace(e.Value);
		if (description.Elements().Any(e => !IsSupported(e)))
			throw new OperationException(OperationFailure.UnsupportedOperation, "This entity contains broker fields that the copy workflow cannot preserve. Review the unsupported configuration before copying.");
		return new(Configuration(target, settings), description.Elements().FirstOrDefault(e => e.Name.LocalName == "CreatedAt")?.Value ?? "");
	}
	public async Task CreateEntityCopyAsync(EntityTarget target, EntitySettings settings, string guardRule, Action dispatching, CancellationToken cancellation)
	{
		Validate(target, settings);
		if (settings.Status != "Disabled")
			throw new OperationException(OperationFailure.InvalidInput, "Configuration copies must start disabled.");
		if (target.Kind != "subscription")
		{
			await ChangeEntityAsync("create", target, settings, null, dispatching, cancellation);
			return;
		}
		SubscriptionRules.Target(target, guardRule);
		var options = CopySubscriptionOptions(target, settings);
		cancellation.ThrowIfCancellationRequested();
		dispatching();
		// This overload atomically creates the subscription with a false rule, never the default match-all rule.
		await admin.CreateSubscriptionAsync(options, new CreateRuleOptions(guardRule, new FalseRuleFilter()), cancellation);
	}
}
