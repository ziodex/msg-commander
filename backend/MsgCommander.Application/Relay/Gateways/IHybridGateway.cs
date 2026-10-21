using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Application.AccessPolicies;
using MsgCommander.Application.Relay.Management;
using MsgCommander.Application.Relay.Hybrid;
using MsgCommander.Contracts.Relay.Management;
using MsgCommander.Contracts.Relay.Hybrid;
using MsgCommander.Contracts.Relay.Configuration;
using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.AccessPolicies;

namespace MsgCommander.Application.Relay.Gateways;

public interface IHybridGatewayFactory
{
	IHybridGateway Create(ConnectionProfile profile, HybridRun request, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation);
}

public interface IHybridGateway : IAsyncDisposable
{
	Task RunAsync(HybridRun request, Func<HybridExchange, bool> record, Action<string> phase, CancellationToken cancellation);
}
