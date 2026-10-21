using MsgCommander.Contracts.Connections;

namespace MsgCommander.Application.ServiceBus.Connections;

public interface IServiceBusAuthenticationProbe
{
	Task<AuthenticationCheck> CheckAsync(ConnectionProfile profile, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation);
}
