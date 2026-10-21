using Azure;
using Azure.Identity;
using Azure.Messaging.ServiceBus;
using Azure.Messaging.ServiceBus.Administration;
using static MsgCommander.Application.Common.DisplayValues;
using static MsgCommander.Application.ServiceBus.Messages.MessageProjection;

namespace MsgCommander.Infrastructure.ServiceBus;

public sealed class AzureServiceBusGatewayFactory : IServiceBusGatewayFactory
{
	public Task<IAuthorizationGateway> ConnectAuthorizationAsync(AuthorizationContext context, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation) => AzureAuthorizationGateway.ConnectAsync(context, deviceCode, cancellation);
	public async Task<IServiceBusGateway> ConnectAsync(ConnectionProfile profile, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		if (profile.Service != "service-bus")
			throw new OperationException(OperationFailure.InvalidInput, "Select a Service Bus profile.");
		var adminOptions = new ServiceBusAdministrationClientOptions { Retry = { MaxRetries = 0, NetworkTimeout = TimeSpan.FromSeconds(20) } };
		var messagingOptions = new ServiceBusClientOptions
		{
			TransportType = ServiceBusTransportType.AmqpWebSockets,
			RetryOptions = new ServiceBusRetryOptions { MaxRetries = 0, TryTimeout = TimeSpan.FromSeconds(20) }
		};
		ServiceBusAdministrationClient admin;
		ServiceBusClient messaging;
		Func<ServiceBusClient> receiverClient;
		ServiceBusClientOptions ReceiverOptions() => new()
		{
			EnableCrossEntityTransactions = true,
			TransportType = messagingOptions.TransportType,
			RetryOptions = new()
			{
				MaxRetries = 0,
				TryTimeout = TimeSpan.FromSeconds(20)
			}
		};
		if (profile.Auth == "sas")
		{
			var endpoint = ServiceBusEndpoint.Resolve(profile);
			messagingOptions.TransportType = endpoint.Transport;
			admin = new(endpoint.Administration, adminOptions);
			messaging = new(profile.Secret, messagingOptions);
			receiverClient = () => new(profile.Secret, ReceiverOptions());
		}
		else if (profile.Auth == "device-code")
		{
			var credential = new DeviceCodeCredential(new DeviceCodeCredentialOptions
			{
				TenantId = profile.TenantId,
				ClientId = profile.ClientId,
				AuthorityHost = AzureAuthorityHosts.AzurePublicCloud,
				DeviceCodeCallback = (code, token) =>
				{
					token.ThrowIfCancellationRequested();
					return deviceCode(new(code.UserCode, Timestamp(code.ExpiresOn)));
				},
				Retry = { MaxRetries = 0 }
			});
			admin = new(profile.Namespace, credential, adminOptions);
			messaging = new(profile.Namespace, credential, messagingOptions);
			receiverClient = () => new(profile.Namespace, credential, ReceiverOptions());
		}
		else
			throw new OperationException(OperationFailure.InvalidInput, "Unsupported authentication method.");
		try
		{
			// Establish management access; Listen permission is checked separately on the first peek.
			await admin.GetNamespacePropertiesAsync(cancellation);
			cancellation.ThrowIfCancellationRequested();
			return new AzureServiceBusGateway(admin, messaging, receiverClient);
		}
		catch { await messaging.DisposeAsync(); throw; }
	}
}

public sealed partial class AzureServiceBusGateway(ServiceBusAdministrationClient admin, ServiceBusClient messaging, Func<ServiceBusClient>? receiverClient = null) : IServiceBusGateway
{
	private ServiceBusReceiver? receiver;
	private (EntityTarget Target, string SubQueue)? receiverKey;
	public IAsyncEnumerable<string> ListSessionsAsync(EntityTarget target, CancellationToken cancellation)
	{
		target.Validate(peek: true);
		return target.Kind == "queue" ? messaging.GetMessageSessionsAsync(target.Name, cancellation)
			: messaging.GetMessageSessionsAsync(target.TopicName, target.Name, cancellation);
	}
	public async Task SendAsync(EntityTarget target, OutgoingMessage message, CancellationToken cancellation)
	{
		OutgoingMessages.ValidateDestination(target);
		await using var sender = messaging.CreateSender(target.Name);
		await sender.SendMessageAsync(AzureOutgoingMessage.ToSdk(message), cancellation);
	}
	public async Task<IMessageReceiver> OpenNextSessionAsync(EntityTarget target, CancellationToken cancellation)
	{
		target.Validate(peek: true);
		var client = (receiverClient ?? throw new InvalidOperationException("Receiver client factory missing."))();
		try
		{
			var options = new ServiceBusSessionReceiverOptions { PrefetchCount = 0, ReceiveMode = ServiceBusReceiveMode.PeekLock };
			var receiver = target.Kind == "queue" ? await client.AcceptNextSessionAsync(target.Name, options, cancellation)
				: await client.AcceptNextSessionAsync(target.TopicName, target.Name, options, cancellation);
			return new AzureMessageReceiver(client, receiver);
		}
		catch { await client.DisposeAsync(); throw; }
	}
	public Task<IMessageReceiver> OpenReceiverAsync(EntityTarget target, string subQueue, string sessionId, CancellationToken cancellation)
		=> OpenReceiver(target, subQueue, sessionId, ServiceBusReceiveMode.PeekLock, cancellation);
	public Task<IMessageReceiver> OpenReceiveDeleteReceiverAsync(EntityTarget target, string subQueue, string sessionId, CancellationToken cancellation)
		=> OpenReceiver(target, subQueue, sessionId, ServiceBusReceiveMode.ReceiveAndDelete, cancellation);
	private async Task<IMessageReceiver> OpenReceiver(EntityTarget target, string subQueue, string sessionId, ServiceBusReceiveMode mode, CancellationToken cancellation)
	{
		target.Validate(peek: true);
		var selectedSubQueue = MessageSubqueues.Parse(subQueue);
		if (selectedSubQueue != SubQueue.None && !string.IsNullOrEmpty(sessionId))
			throw new OperationException(OperationFailure.InvalidInput, "Dead-letter receives use a regular receiver without a session filter.");
		// A fresh client per receive batch avoids cross-entity transaction affinity leaking across entities or ordinary sends.
		var client = (receiverClient ?? throw new InvalidOperationException("Receiver client factory missing."))();
		try
		{
			ServiceBusReceiver owned;
			if (!string.IsNullOrEmpty(sessionId))
			{
				var options = new ServiceBusSessionReceiverOptions { PrefetchCount = 0, ReceiveMode = mode };
				owned = target.Kind == "queue" ? await client.AcceptSessionAsync(target.Name, sessionId, options, cancellation)
					: await client.AcceptSessionAsync(target.TopicName, target.Name, sessionId, options, cancellation);
			}
			else
			{
				var options = new ServiceBusReceiverOptions { SubQueue = selectedSubQueue, PrefetchCount = 0, ReceiveMode = mode };
				owned = target.Kind == "queue" ? client.CreateReceiver(target.Name, options) : client.CreateReceiver(target.TopicName, target.Name, options);
			}
			return new AzureMessageReceiver(client, owned);
		}
		catch { await client.DisposeAsync(); throw; }
	}
	public async Task<EntityPage> ListAsync(string kind, string? topicName, string? continuationToken, CancellationToken cancellation) => kind switch
	{
		"queue" => await Page(admin.GetQueuesAsync(cancellation), continuationToken,
			item => new(new("queue", item.Name), item.Status.ToString(), item.RequiresSession), cancellation),
		"topic" => await Page(admin.GetTopicsAsync(cancellation), continuationToken,
			item => new(new("topic", item.Name), item.Status.ToString(), null), cancellation),
		"subscription" when !string.IsNullOrWhiteSpace(topicName) => await Page(admin.GetSubscriptionsAsync(topicName, cancellation), continuationToken,
			item => new(new("subscription", item.SubscriptionName, topicName), item.Status.ToString(), item.RequiresSession), cancellation),
		_ => throw new OperationException(OperationFailure.InvalidInput, "Choose an entity category; subscriptions need a topic.")
	};

	private static async Task<EntityPage> Page<T>(AsyncPageable<T> values, string? continuation, Func<T, EntityInfo> project, CancellationToken cancellation) where T : notnull
	{
		await foreach (var page in values.AsPages(continuation, 100).WithCancellation(cancellation))
			return new(page.Values.Select(project).ToArray(), page.ContinuationToken);
		return new([], null);
	}

	public async Task<EntityDetails> GetEntityAsync(EntityTarget target, CancellationToken cancellation)
	{
		target.Validate();
		EntityInfo entity;
		List<PropertyValue> properties;
		switch (target.Kind)
		{
			case "queue":
				var queue = (await admin.GetQueueAsync(target.Name, cancellation)).Value;
				entity = new(target, queue.Status.ToString(), queue.RequiresSession);
				properties = [Property("LockDuration", queue.LockDuration), Property("DefaultMessageTimeToLive", queue.DefaultMessageTimeToLive),
					Property("MaxDeliveryCount", queue.MaxDeliveryCount), Property("MaxSizeInMegabytes", queue.MaxSizeInMegabytes),
					Property("RequiresSession", queue.RequiresSession), Property("RequiresDuplicateDetection", queue.RequiresDuplicateDetection),
					Property("DeadLetteringOnMessageExpiration", queue.DeadLetteringOnMessageExpiration), Property("EnablePartitioning", queue.EnablePartitioning),
					Property("ForwardTo", queue.ForwardTo), Property("ForwardDeadLetteredMessagesTo", queue.ForwardDeadLetteredMessagesTo)];
				break;
			case "topic":
				var topic = (await admin.GetTopicAsync(target.Name, cancellation)).Value;
				entity = new(target, topic.Status.ToString(), null);
				properties = [Property("DefaultMessageTimeToLive", topic.DefaultMessageTimeToLive), Property("MaxSizeInMegabytes", topic.MaxSizeInMegabytes),
					Property("RequiresDuplicateDetection", topic.RequiresDuplicateDetection), Property("EnablePartitioning", topic.EnablePartitioning)];
				break;
			default:
				var subscription = (await admin.GetSubscriptionAsync(target.TopicName, target.Name, cancellation)).Value;
				entity = new(target, subscription.Status.ToString(), subscription.RequiresSession);
				properties = [Property("LockDuration", subscription.LockDuration), Property("DefaultMessageTimeToLive", subscription.DefaultMessageTimeToLive),
					Property("RequiresSession", subscription.RequiresSession), Property("MaxDeliveryCount", subscription.MaxDeliveryCount),
					Property("DeadLetteringOnMessageExpiration", subscription.DeadLetteringOnMessageExpiration),
					Property("EnableDeadLetteringOnFilterEvaluationExceptions", subscription.EnableDeadLetteringOnFilterEvaluationExceptions),
					Property("ForwardTo", subscription.ForwardTo), Property("ForwardDeadLetteredMessagesTo", subscription.ForwardDeadLetteredMessagesTo)];
				break;
		}
		EntityCounts counts = new();
		string? warning = null;
		try
		{
			switch (target.Kind)
			{
				case "queue":
					var queue = (await admin.GetQueueRuntimePropertiesAsync(target.Name, cancellation)).Value;
					counts = new(Number(queue.ActiveMessageCount), Number(queue.DeadLetterMessageCount), Number(queue.ScheduledMessageCount),
						Number(queue.TransferMessageCount), Number(queue.TransferDeadLetterMessageCount), Number(queue.TotalMessageCount), Number(queue.SizeInBytes));
					break;
				case "topic":
					var topic = (await admin.GetTopicRuntimePropertiesAsync(target.Name, cancellation)).Value;
					counts = new(Scheduled: Number(topic.ScheduledMessageCount), SizeBytes: Number(topic.SizeInBytes));
					properties.Add(Property("SubscriptionCount", topic.SubscriptionCount));
					break;
				default:
					var subscription = (await admin.GetSubscriptionRuntimePropertiesAsync(target.TopicName, target.Name, cancellation)).Value;
					counts = new(Number(subscription.ActiveMessageCount), Number(subscription.DeadLetterMessageCount), null,
						Number(subscription.TransferMessageCount), Number(subscription.TransferDeadLetterMessageCount), Number(subscription.TotalMessageCount));
					break;
			}
		}
		catch (RequestFailedException) { warning = "Entity settings loaded, but runtime counts are unavailable. Refresh after checking permissions and connectivity."; }
		return new(entity, properties, counts, warning, Timestamp(DateTimeOffset.UtcNow));
	}

	public async Task<ReceivedMessage?> PeekOneAsync(EntityTarget target, string subQueue, long fromSequenceNumber, CancellationToken cancellation)
	{
		target.Validate();
		var selectedSubQueue = MessageSubqueues.Parse(subQueue);
		if (target.Kind == "topic" && selectedSubQueue != SubQueue.None)
			throw new OperationException(OperationFailure.InvalidInput, "Topics have no direct dead-letter view.");
		var key = (target, subQueue);
		if (receiverKey != key)
		{
			if (receiver is not null)
				await receiver.DisposeAsync();
			receiver = null;
			receiverKey = null;
			var options = new ServiceBusReceiverOptions { SubQueue = selectedSubQueue, PrefetchCount = 0 };
			// No session acceptance, prefetch, receive or settlement; each peek uses an explicit sequence.
			receiver = target.Kind != "subscription" ? messaging.CreateReceiver(target.Name, options) : messaging.CreateReceiver(target.TopicName, target.Name, options);
			receiverKey = key;
		}
		var message = (await receiver!.PeekMessagesAsync(1, fromSequenceNumber, cancellation)).FirstOrDefault();
		return message is null ? null : AzureReceivedMessage.Snapshot(message);
	}
	public async ValueTask DisposeAsync()
	{
		try
		{
			if (receiver is not null)
				await receiver.DisposeAsync();
		}
		finally { await messaging.DisposeAsync(); }
	}
}
