using Azure.Messaging.ServiceBus.Administration;
using static MsgCommander.Application.ServiceBus.Entities.EntityManagement;

namespace MsgCommander.Infrastructure.ServiceBus;

public sealed partial class AzureServiceBusGateway
{
	private string Forward(string? value)
	{
		if (string.IsNullOrEmpty(value))
			return "";
		// Azure can return forwarding destinations as absolute URLs in this namespace.
		if (Uri.TryCreate(value, UriKind.Absolute, out var uri) && string.Equals(uri.Host, messaging.FullyQualifiedNamespace, StringComparison.OrdinalIgnoreCase))
			return Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/'));
		return value;
	}
	private EntitySettings Settings(QueueProperties q) => new(
		Status: q.Status.ToString(),
		DefaultMessageTimeToLive: Duration(q.DefaultMessageTimeToLive, "unlimited"),
		AutoDeleteOnIdle: Duration(q.AutoDeleteOnIdle, "disabled"),
		EnableBatchedOperations: q.EnableBatchedOperations,
		UserMetadata: q.UserMetadata ?? "",
		LockDuration: Duration(q.LockDuration),
		MaxDeliveryCount: q.MaxDeliveryCount,
		DeadLetteringOnMessageExpiration: q.DeadLetteringOnMessageExpiration,
		ForwardTo: Forward(q.ForwardTo),
		ForwardDeadLetteredMessagesTo: Forward(q.ForwardDeadLetteredMessagesTo),
		RequiresSession: q.RequiresSession,
		MaxSizeInMegabytes: q.MaxSizeInMegabytes,
		MaxMessageSizeInKilobytes: q.MaxMessageSizeInKilobytes,
		RequiresDuplicateDetection: q.RequiresDuplicateDetection,
		DuplicateDetectionHistoryTimeWindow: Duration(q.DuplicateDetectionHistoryTimeWindow),
		EnablePartitioning: q.EnablePartitioning,
		SupportOrdering: null,
		EnableDeadLetteringOnFilterEvaluationExceptions: null);
	private EntitySettings Settings(TopicProperties q) => new(
		Status: q.Status.ToString(),
		DefaultMessageTimeToLive: Duration(q.DefaultMessageTimeToLive, "unlimited"),
		AutoDeleteOnIdle: Duration(q.AutoDeleteOnIdle, "disabled"),
		EnableBatchedOperations: q.EnableBatchedOperations,
		UserMetadata: q.UserMetadata ?? "",
		LockDuration: null,
		MaxDeliveryCount: null,
		DeadLetteringOnMessageExpiration: null,
		ForwardTo: null,
		ForwardDeadLetteredMessagesTo: null,
		RequiresSession: null,
		MaxSizeInMegabytes: q.MaxSizeInMegabytes,
		MaxMessageSizeInKilobytes: q.MaxMessageSizeInKilobytes,
		RequiresDuplicateDetection: q.RequiresDuplicateDetection,
		DuplicateDetectionHistoryTimeWindow: Duration(q.DuplicateDetectionHistoryTimeWindow),
		EnablePartitioning: q.EnablePartitioning,
		SupportOrdering: q.SupportOrdering,
		EnableDeadLetteringOnFilterEvaluationExceptions: null);
	private EntitySettings Settings(SubscriptionProperties q) => new(
		Status: q.Status.ToString(),
		DefaultMessageTimeToLive: Duration(q.DefaultMessageTimeToLive, "unlimited"),
		AutoDeleteOnIdle: Duration(q.AutoDeleteOnIdle, "disabled"),
		EnableBatchedOperations: q.EnableBatchedOperations,
		UserMetadata: q.UserMetadata ?? "",
		LockDuration: Duration(q.LockDuration),
		MaxDeliveryCount: q.MaxDeliveryCount,
		DeadLetteringOnMessageExpiration: q.DeadLetteringOnMessageExpiration,
		ForwardTo: Forward(q.ForwardTo),
		ForwardDeadLetteredMessagesTo: Forward(q.ForwardDeadLetteredMessagesTo),
		RequiresSession: q.RequiresSession,
		MaxSizeInMegabytes: null,
		MaxMessageSizeInKilobytes: null,
		RequiresDuplicateDetection: null,
		DuplicateDetectionHistoryTimeWindow: null,
		EnablePartitioning: null,
		SupportOrdering: null,
		EnableDeadLetteringOnFilterEvaluationExceptions: q.EnableDeadLetteringOnFilterEvaluationExceptions);
	public async Task<EntityConfiguration> GetEntityConfigurationAsync(EntityTarget target, CancellationToken cancellation)
	{
		ValidateTarget(target);
		var settings = target.Kind switch
		{
			"queue" => Settings((await admin.GetQueueAsync(target.Name, cancellation)).Value),
			"topic" => Settings((await admin.GetTopicAsync(target.Name, cancellation)).Value),
			_ => Settings((await admin.GetSubscriptionAsync(target.TopicName, target.Name, cancellation)).Value)
		};
		return Configuration(target, settings);
	}
	private async Task InvalidatePeek(EntityTarget target)
	{
		if (receiverKey is { } key && Affects(target, key.Target))
		{
			var previous = receiver;
			receiver = null;
			receiverKey = null;
			if (previous is not null)
				await previous.DisposeAsync();
		}
	}
	public async Task ChangeEntityAsync(string action, EntityTarget target, EntitySettings? settings, string? expectedRevision, Action dispatching, CancellationToken cancellation)
	{
		ValidateTarget(target);
		if (action is not ("create" or "update" or "delete"))
			throw new OperationException(OperationFailure.InvalidInput, "Unsupported entity action.");
		if (action != "delete")
			Validate(target, settings ?? throw new OperationException(OperationFailure.InvalidInput, "Entity settings required."));
		async Task Dispatch()
		{
			await InvalidatePeek(target);
			cancellation.ThrowIfCancellationRequested();
			dispatching();
		}
		if (action == "create")
		{
			var s = settings!;
			if (target.Kind == "queue")
			{
				var options = new CreateQueueOptions(target.Name)
				{
					Status = s.Status,
					DefaultMessageTimeToLive = Duration(s.DefaultMessageTimeToLive, "unlimited"),
					AutoDeleteOnIdle = Duration(s.AutoDeleteOnIdle, "disabled"),
					EnableBatchedOperations = s.EnableBatchedOperations,
					UserMetadata = s.UserMetadata,
					LockDuration = Duration(s.LockDuration),
					MaxDeliveryCount = s.MaxDeliveryCount!.Value,
					DeadLetteringOnMessageExpiration = s.DeadLetteringOnMessageExpiration!.Value,
					ForwardTo = s.ForwardTo,
					ForwardDeadLetteredMessagesTo = s.ForwardDeadLetteredMessagesTo,
					RequiresSession = s.RequiresSession!.Value,
					MaxSizeInMegabytes = s.MaxSizeInMegabytes!.Value,
					MaxMessageSizeInKilobytes = s.MaxMessageSizeInKilobytes,
					RequiresDuplicateDetection = s.RequiresDuplicateDetection!.Value,
					DuplicateDetectionHistoryTimeWindow = Duration(s.DuplicateDetectionHistoryTimeWindow),
					EnablePartitioning = s.EnablePartitioning!.Value
				};
				await Dispatch();
				await admin.CreateQueueAsync(options, cancellation);
			}
			else if (target.Kind == "topic")
			{
				var options = new CreateTopicOptions(target.Name)
				{
					Status = s.Status,
					DefaultMessageTimeToLive = Duration(s.DefaultMessageTimeToLive, "unlimited"),
					AutoDeleteOnIdle = Duration(s.AutoDeleteOnIdle, "disabled"),
					EnableBatchedOperations = s.EnableBatchedOperations,
					UserMetadata = s.UserMetadata,
					MaxSizeInMegabytes = s.MaxSizeInMegabytes!.Value,
					MaxMessageSizeInKilobytes = s.MaxMessageSizeInKilobytes,
					RequiresDuplicateDetection = s.RequiresDuplicateDetection!.Value,
					DuplicateDetectionHistoryTimeWindow = Duration(s.DuplicateDetectionHistoryTimeWindow),
					EnablePartitioning = s.EnablePartitioning!.Value,
					SupportOrdering = s.SupportOrdering!.Value
				};
				await Dispatch();
				await admin.CreateTopicAsync(options, cancellation);
			}
			else if (target.Kind == "subscription")
			{
				var options = CopySubscriptionOptions(target, s);
				await Dispatch();
				await admin.CreateSubscriptionAsync(options, cancellation);
			}
			return;
		}
		// Fetch-modify-update preserves unknown SDK fields, authorization and subscription rules.
		// SDK updates use If-Match: *; the revision check is best effort, not an atomic compare-and-swap.
		if (target.Kind == "queue")
		{
			var current = (await admin.GetQueueAsync(target.Name, cancellation)).Value;
			CheckRevision(Configuration(target, Settings(current)), expectedRevision);
			if (action == "delete")
			{
				await Dispatch();
				await admin.DeleteQueueAsync(target.Name, cancellation);
			}
			else
			{
				CheckImmutable(Settings(current), settings!);
				Apply(current, settings!);
				await Dispatch();
				await admin.UpdateQueueAsync(current, cancellation);
			}
		}
		else if (target.Kind == "topic")
		{
			var current = (await admin.GetTopicAsync(target.Name, cancellation)).Value;
			CheckRevision(Configuration(target, Settings(current)), expectedRevision);
			if (action == "delete")
			{
				await Dispatch();
				await admin.DeleteTopicAsync(target.Name, cancellation);
			}
			else
			{
				CheckImmutable(Settings(current), settings!);
				Apply(current, settings!);
				await Dispatch();
				await admin.UpdateTopicAsync(current, cancellation);
			}
		}
		else if (target.Kind == "subscription")
		{
			var current = (await admin.GetSubscriptionAsync(target.TopicName, target.Name, cancellation)).Value;
			CheckRevision(Configuration(target, Settings(current)), expectedRevision);
			if (action == "delete")
			{
				await Dispatch();
				await admin.DeleteSubscriptionAsync(target.TopicName, target.Name, cancellation);
			}
			else
			{
				CheckImmutable(Settings(current), settings!);
				Apply(current, settings!);
				await Dispatch();
				await admin.UpdateSubscriptionAsync(current, cancellation);
			}
		}
	}
	private static CreateSubscriptionOptions CopySubscriptionOptions(EntityTarget target, EntitySettings s) => new(target.TopicName, target.Name)
	{
		Status = s.Status,
		DefaultMessageTimeToLive = Duration(s.DefaultMessageTimeToLive, "unlimited"),
		AutoDeleteOnIdle = Duration(s.AutoDeleteOnIdle, "disabled"),
		EnableBatchedOperations = s.EnableBatchedOperations,
		UserMetadata = s.UserMetadata,
		LockDuration = Duration(s.LockDuration),
		MaxDeliveryCount = s.MaxDeliveryCount!.Value,
		DeadLetteringOnMessageExpiration = s.DeadLetteringOnMessageExpiration!.Value,
		ForwardTo = s.ForwardTo,
		ForwardDeadLetteredMessagesTo = s.ForwardDeadLetteredMessagesTo,
		RequiresSession = s.RequiresSession!.Value,
		EnableDeadLetteringOnFilterEvaluationExceptions = s.EnableDeadLetteringOnFilterEvaluationExceptions!.Value
	};

	private static void Apply(QueueProperties q, EntitySettings s)
	{
		q.Status = s.Status;
		q.DefaultMessageTimeToLive = Duration(s.DefaultMessageTimeToLive, "unlimited");
		q.AutoDeleteOnIdle = Duration(s.AutoDeleteOnIdle, "disabled");
		q.EnableBatchedOperations = s.EnableBatchedOperations;
		q.UserMetadata = s.UserMetadata;
		q.LockDuration = Duration(s.LockDuration);
		q.MaxDeliveryCount = s.MaxDeliveryCount!.Value;
		q.DeadLetteringOnMessageExpiration = s.DeadLetteringOnMessageExpiration!.Value;
		q.ForwardTo = s.ForwardTo;
		q.ForwardDeadLetteredMessagesTo = s.ForwardDeadLetteredMessagesTo;
		q.MaxSizeInMegabytes = s.MaxSizeInMegabytes!.Value;
		q.MaxMessageSizeInKilobytes = s.MaxMessageSizeInKilobytes;
		q.DuplicateDetectionHistoryTimeWindow = Duration(s.DuplicateDetectionHistoryTimeWindow);
	}
	private static void Apply(TopicProperties q, EntitySettings s)
	{
		q.Status = s.Status;
		q.DefaultMessageTimeToLive = Duration(s.DefaultMessageTimeToLive, "unlimited");
		q.AutoDeleteOnIdle = Duration(s.AutoDeleteOnIdle, "disabled");
		q.EnableBatchedOperations = s.EnableBatchedOperations;
		q.UserMetadata = s.UserMetadata;
		q.MaxSizeInMegabytes = s.MaxSizeInMegabytes!.Value;
		q.MaxMessageSizeInKilobytes = s.MaxMessageSizeInKilobytes;
		q.DuplicateDetectionHistoryTimeWindow = Duration(s.DuplicateDetectionHistoryTimeWindow);
		q.SupportOrdering = s.SupportOrdering!.Value;
	}
	private static void Apply(SubscriptionProperties q, EntitySettings s)
	{
		q.Status = s.Status;
		q.DefaultMessageTimeToLive = Duration(s.DefaultMessageTimeToLive, "unlimited");
		q.AutoDeleteOnIdle = Duration(s.AutoDeleteOnIdle, "disabled");
		q.EnableBatchedOperations = s.EnableBatchedOperations;
		q.UserMetadata = s.UserMetadata;
		q.LockDuration = Duration(s.LockDuration);
		q.MaxDeliveryCount = s.MaxDeliveryCount!.Value;
		q.DeadLetteringOnMessageExpiration = s.DeadLetteringOnMessageExpiration!.Value;
		q.ForwardTo = s.ForwardTo;
		q.ForwardDeadLetteredMessagesTo = s.ForwardDeadLetteredMessagesTo;
		q.EnableDeadLetteringOnFilterEvaluationExceptions = s.EnableDeadLetteringOnFilterEvaluationExceptions!.Value;
	}
}
