using Azure.Core;
using Azure.Identity;
using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Consumer;
using Azure.Messaging.EventHubs.Producer;
using Azure.Messaging.EventHubs.Primitives;
using Azure.ResourceManager;
using Azure.ResourceManager.EventHubs;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Infrastructure.EventHubs;

public sealed class AzureEventHubsGatewayFactory : IEventHubsGatewayFactory
{
	public async Task<IEventHubsGateway> ConnectAsync(ConnectionProfile profile, EventHubsManagementContext? management, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		if (profile.Service == "iot-hub")
		{
			var endpoint = IotHubEndpoint.Validate(profile);
			if (management is not null)
				throw new OperationException(OperationFailure.InvalidInput, "Event Hubs ARM management is not available for an IoT Hub built-in endpoint.");
			return new AzureEventHubsGateway(profile with
			{
				Secret = endpoint.ConnectionString
			}, null, endpoint.HubName, null);
		}
		if (profile.Service != "event-hubs" || !System.Text.RegularExpressions.Regex.IsMatch(profile.Namespace, @"^[a-z0-9][a-z0-9-]{4,48}[a-z0-9]\.servicebus\.windows\.net$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
			throw new OperationException(OperationFailure.InvalidInput, "Use an Event Hubs profile with an Azure Public Cloud namespace hostname.");
		TokenCredential? credential = null;
		string? restrictedHub = null;
		if (profile.Auth == "sas")
		{
			var properties = EventHubsConnectionStringProperties.Parse(profile.Secret);
			if (!string.Equals(properties.FullyQualifiedNamespace, profile.Namespace, StringComparison.OrdinalIgnoreCase))
				throw new OperationException(OperationFailure.InvalidInput, "The connection string endpoint must match this namespace.");
			restrictedHub = properties.EventHubName;
		}
		else if (profile.Auth == "device-code")
			credential = MsgCommander.Infrastructure.Authentication.AzureDeviceCodeCredential.Create(profile.TenantId, profile.ClientId, deviceCode);
		else
			throw new OperationException(OperationFailure.InvalidInput, "Unsupported Event Hubs authentication mode.");
		EventHubsNamespaceResource? resource = null;
		ArmClient? managementClient = null;
		if (management is not null)
		{
			management.Validate(profile.Namespace);
			var armCredential = profile.Auth == "device-code" && profile.TenantId == management.TenantId && profile.ClientId == management.ClientId
				? credential! : MsgCommander.Infrastructure.Authentication.AzureDeviceCodeCredential.Create(management.TenantId, management.ClientId, deviceCode);
			var options = new ArmClientOptions { Environment = ArmEnvironment.AzurePublicCloud, Retry = { MaxRetries = 0, NetworkTimeout = TimeSpan.FromSeconds(20) }, Diagnostics = { IsLoggingContentEnabled = false } };
			var arm = managementClient = new ArmClient(armCredential, defaultSubscriptionId: null, options);
			resource = (await arm.GetEventHubsNamespaceResource(new ResourceIdentifier(management.ResourceId)).GetAsync(cancellation)).Value;
			var endpoint = resource.Data.ServiceBusEndpoint;
			if (endpoint is null || !Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || !string.Equals(uri.Host, profile.Namespace, StringComparison.OrdinalIgnoreCase))
				throw new OperationException(OperationFailure.InvalidInput, "The management resource endpoint does not match this profile.");
		}
		return new AzureEventHubsGateway(profile, credential, restrictedHub, resource, managementClient);
	}
}
public sealed class AzureEventHubsGateway(ConnectionProfile profile, TokenCredential? credential, string? restrictedHub, EventHubsNamespaceResource? resource, ArmClient? managementClient = null) : IEventHubsGateway
{
	public bool CanBrowse => resource is not null;
	public IEventHubsAdministration? Administration { get; } = resource is null || managementClient is null ? null : new AzureEventHubsAdministration(managementClient, resource);
	private void ValidateHub(string hub)
	{
		EventHubsValidation.Name(hub);
		if (!string.IsNullOrEmpty(restrictedHub) && !string.Equals(restrictedHub, hub, StringComparison.OrdinalIgnoreCase))
			throw new OperationException(OperationFailure.InvalidInput, "This connection string is restricted to a different Event Hub. Use its EntityPath or another profile.");
	}
	public static EventHubConsumerClientOptions ConsumerOptions() => new()
	{
		ConnectionOptions = new()
		{
			TransportType = EventHubsTransportType.AmqpWebSockets
		},
		RetryOptions = new()
		{
			MaximumRetries = 0,
			TryTimeout = TimeSpan.FromSeconds(20)
		}
	};
	public static PartitionReceiverOptions ReaderOptions() => new()
	{
		ConnectionOptions = new()
		{
			TransportType = EventHubsTransportType.AmqpWebSockets
		},
		RetryOptions = new()
		{
			MaximumRetries = 0,
			TryTimeout = TimeSpan.FromSeconds(20)
		},
		PrefetchCount = 0,
		OwnerLevel = null,
		DefaultMaximumReceiveWaitTime = TimeSpan.FromSeconds(2)
	};
	private EventHubConsumerClient Consumer(string hub)
	{
		ValidateHub(hub);
		return credential is null ? new("$Default", profile.Secret, hub, ConsumerOptions()) : new("$Default", profile.Namespace, hub, credential, ConsumerOptions());
	}
	public static EventHubProducerClientOptions ProducerOptions() => new()
	{
		ConnectionOptions = new()
		{
			TransportType = EventHubsTransportType.AmqpWebSockets
		},
		RetryOptions = new()
		{
			MaximumRetries = 0,
			TryTimeout = TimeSpan.FromSeconds(20)
		}
	};
	private EventHubProducerClient Producer(string hub)
	{
		if (profile.Service == "iot-hub")
			throw new OperationException(OperationFailure.InvalidInput, "Sending is unavailable on the read-only IoT Hub built-in endpoint.");
		ValidateHub(hub);
		return credential is null ? new(profile.Secret, hub, ProducerOptions()) : new(profile.Namespace, hub, credential, ProducerOptions());
	}
	public IEventHubSender OpenSender(string hubName) => new AzureEventHubSender(Producer(hubName));
	public async Task<EventHubInfo> GetHubAsync(string hubName, CancellationToken cancellation, bool forSending = false)
	{
		if (forSending)
		{
			await using var producer = Producer(hubName);
			var sendingInfo = await producer.GetEventHubPropertiesAsync(cancellation);
			return new(sendingInfo.Name, sendingInfo.PartitionIds, Timestamp(sendingInfo.CreatedOn));
		}
		await using var consumer = Consumer(hubName);
		var info = await consumer.GetEventHubPropertiesAsync(cancellation);
		return new(info.Name, info.PartitionIds, Timestamp(info.CreatedOn));
	}
	public async Task<EventHubPartition> GetPartitionAsync(string hubName, string partitionId, CancellationToken cancellation, bool forSending = false)
	{
		if (forSending)
		{
			await using var producer = Producer(hubName);
			return Project(await producer.GetPartitionPropertiesAsync(partitionId, cancellation));
		}
		await using var consumer = Consumer(hubName);
		var value = await consumer.GetPartitionPropertiesAsync(partitionId, cancellation);
		return Project(value);
	}
	public static EventHubPartition Project(PartitionProperties value) => new(value.EventHubName, value.Id, value.IsEmpty,
		value.IsEmpty ? null : Number(value.BeginningSequenceNumber), value.IsEmpty ? null : Number(value.LastEnqueuedSequenceNumber),
		value.IsEmpty ? null : value.LastEnqueuedOffsetString, value.IsEmpty ? null : Timestamp(value.LastEnqueuedTime));
	public IEventHubReader OpenReader(string hubName, string consumerGroup, string partitionId, MsgCommander.Domain.EventHubs.StreamPosition position)
	{
		ValidateHub(hubName);
		EventHubsValidation.Name(consumerGroup, true);
		EventHubsValidation.Partition(partitionId);
		var reader = credential is null ? new PartitionReceiver(consumerGroup, partitionId, AzureEventPositions.ToSdk(position), profile.Secret, hubName, ReaderOptions())
			: new PartitionReceiver(consumerGroup, partitionId, AzureEventPositions.ToSdk(position), profile.Namespace, hubName, credential, ReaderOptions());
		return new AzureEventHubReader(reader);
	}
	public async Task<EventHubsPage> ListAsync(string kind, string hubName, string? continuation, CancellationToken cancellation)
	{
		if (resource is null)
			throw new OperationException(OperationFailure.AuthenticationRequired, "Namespace browsing needs a separate Entra management sign-in. A known hub can still be opened using data access.");
		if (kind == "hubs")
		{
			await foreach (var page in resource.GetEventHubs().GetAllAsync(cancellationToken: cancellation).AsPages(continuation, 100))
				return new(page.Values.Select(v => new EventHubsListItem(v.Data.Name, v.Data.Status?.ToString(), v.Data.PartitionCount is null ? null : checked((int)v.Data.PartitionCount.Value), null)).ToArray(), page.ContinuationToken);
		}
		else
		{
			EventHubsValidation.Name(hubName);
			var hub = (await resource.GetEventHubs().GetAsync(hubName, cancellation)).Value;
			await foreach (var page in hub.GetEventHubsConsumerGroups().GetAllAsync(cancellationToken: cancellation).AsPages(continuation, 100))
				return new(page.Values.Select(v => new EventHubsListItem(v.Data.Name, null, null,
					v.Data.UserMetadata is { Length: > 1024 } metadata ? metadata[..1023] + "…" : v.Data.UserMetadata)).ToArray(), page.ContinuationToken);
		}
		return new([], null);
	}
	public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
public sealed class AzureEventHubReader(PartitionReceiver receiver) : IEventHubReader
{
	public async Task<IReadOnlyList<ReceivedEvent>> ReadAsync(TimeSpan wait, CancellationToken cancellation)
		=> (await receiver.ReceiveBatchAsync(1, wait, cancellation)).Select(value => (ReceivedEvent)new AzureReceivedEvent(value)).ToArray();
	public ValueTask DisposeAsync() => receiver.DisposeAsync();
}
