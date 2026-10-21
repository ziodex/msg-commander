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

public interface IRelayGatewayFactory
{
	Task<IRelayGateway> ConnectAsync(ConnectionProfile profile, RelayManagement management, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation);
}

public interface IRelayGateway : IAsyncDisposable
{
	string Location
	{
		get;
	}

	Task<RelayDetails> GetAsync(RelayTarget target, CancellationToken cancellation);
	Task<RelayPage> ListAsync(RelayScope scope, string kind, string? continuation, CancellationToken cancellation);
	Task<AuthorizationKey> KeyAsync(RelayTarget target, string keyType, CancellationToken cancellation);
	Task ChangeAsync(RelayChange change, Action dispatching, CancellationToken cancellation);
}
