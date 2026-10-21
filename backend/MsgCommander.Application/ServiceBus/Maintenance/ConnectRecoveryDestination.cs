using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Contracts.Connections;

namespace MsgCommander.Application.ServiceBus.Maintenance;

public delegate Task<IServiceBusMessagingGateway> ConnectRecoveryDestination(ConnectionProfile profile,
	Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation);
