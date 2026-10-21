using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.ServiceBus.Authorization;

namespace MsgCommander.Application.ServiceBus.Authorization;

public interface IAuthorizationGatewayFactory
{
	Task<IAuthorizationGateway> ConnectAuthorizationAsync(AuthorizationContext context, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation);
}
