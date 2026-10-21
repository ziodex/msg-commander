using MsgCommander.Application.EventHubs.Administration;
using MsgCommander.Application.EventHubs.Browsing;
using MsgCommander.Application.EventHubs.Messaging;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.EventHubs.Browsing;
using MsgCommander.Contracts.EventHubs.Messaging;
using MsgCommander.Domain.EventHubs;

namespace MsgCommander.Application.EventHubs.Gateways;

public interface IEventHubReader : IAsyncDisposable
{
	Task<IReadOnlyList<ReceivedEvent>> ReadAsync(TimeSpan wait, CancellationToken cancellation);
}
public interface IEventHubSender : IAsyncDisposable
{
	Task<IEventHubBatch> CreateBatchAsync(EventRouting routing, CancellationToken cancellation);
}
public interface IEventHubBatch : IDisposable
{
	int Count
	{
		get;
	}
	bool TryAdd(OutgoingEvent data);
	Task SendAsync(Action dispatching, CancellationToken cancellation);
}
public interface IEventHubsGateway : IEventHubsCatalog, IAsyncDisposable
{
	bool CanBrowse
	{
		get;
	}
	Task<EventHubInfo> GetHubAsync(string hubName, CancellationToken cancellation, bool forSending = false);
	Task<EventHubPartition> GetPartitionAsync(string hubName, string partitionId, CancellationToken cancellation, bool forSending = false);
	IEventHubSender OpenSender(string hubName);
	IEventHubReader OpenReader(string hubName, string consumerGroup, string partitionId, StreamPosition position);
}
public interface IEventHubsGatewayFactory
{
	Task<IEventHubsGateway> ConnectAsync(ConnectionProfile profile, EventHubsManagementContext? management, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation);
}
