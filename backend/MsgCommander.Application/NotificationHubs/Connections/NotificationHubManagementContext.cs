using MsgCommander.Application.Connections;
using MsgCommander.Application.NotificationHubs.Gateways;
using MsgCommander.Application.NotificationHubs.Management;
using MsgCommander.Application.NotificationHubs.Credentials;
using MsgCommander.Application.NotificationHubs.Configuration;
using MsgCommander.Contracts.NotificationHubs.Management;

namespace MsgCommander.Application.NotificationHubs.Connections;

public sealed class NotificationHubManagementContext
{
	public INotificationHubGateway Gateway
	{
		get;
	}
	public NotificationHubConnection Connection
	{
		get;
	}
	public DeviceCodePrompts Prompts
	{
		get;
	}
	public NotificationHubReceiptStore Receipts { get; } = new();
	public NotificationHubBrowsingService Browsing
	{
		get;
	}
	public NotificationHubAdministrationService Administration
	{
		get;
	}
	public NotificationHubCredentialService Credentials
	{
		get;
	}
	public NotificationHubConfigurationService Configuration
	{
		get;
	}
	public NotificationHubManagementContext(INotificationHubGateway gateway, NotificationHubConnection connection, DeviceCodePrompts prompts,
		IProviderCredentialCodec codec, INotificationHubFailureClassifier failures, TimeProvider? timeProvider)
	{
		Gateway = gateway;
		Connection = connection;
		Prompts = prompts;
		Browsing = new(gateway);
		Administration = new(gateway, failures, Receipts);
		Credentials = new(gateway, codec, failures, Receipts, timeProvider);
		Configuration = new(gateway, connection, Administration, failures, timeProvider);
	}
	public void Close()
	{
		Prompts.Close();
		Browsing.Clear();
		Credentials.Clear();
		Configuration.Clear();
		Receipts.Clear();
	}
}
