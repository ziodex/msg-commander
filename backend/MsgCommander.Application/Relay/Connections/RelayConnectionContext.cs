using MsgCommander.Application.Connections;
using MsgCommander.Application.Relay.Configuration;
using MsgCommander.Application.Relay.Gateways;
using MsgCommander.Application.Relay.Management;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.Relay.Management;

namespace MsgCommander.Application.Relay.Connections;

public sealed record RelayManagementConnect(string OperationId, ConnectionProfile Profile, RelayManagement Management);
public sealed class RelayConnectionContext
{
	public IRelayGateway Gateway
	{
		get;
	}
	public RelayConnection Connection
	{
		get;
	}
	public DeviceCodePrompts Prompts
	{
		get;
	}
	public RelayBrowsingService Browsing
	{
		get;
	}
	public RelayAdministrationService Administration
	{
		get;
	}
	public RelayConfigurationService Configuration
	{
		get;
	}

	public RelayConnectionContext(IRelayGateway gateway, RelayConnection connection, DeviceCodePrompts prompts, IRelayFailureClassifier failures, TimeProvider? timeProvider)
	{
		Gateway = gateway;
		Connection = connection;
		Prompts = prompts;
		Browsing = new(gateway);
		Administration = new(gateway, failures);
		Configuration = new(gateway, connection, Administration, failures, timeProvider ?? TimeProvider.System);
	}

	public void Close()
	{
		Prompts.Close();
		Browsing.Clear();
		Administration.Clear();
		Configuration.Clear();
	}
}
