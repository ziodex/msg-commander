using MsgCommander.Application.NotificationHubs.Gateways;
using MsgCommander.Application.NotificationHubs.Jobs;
using MsgCommander.Application.NotificationHubs.RegistrationFiles;
using MsgCommander.Application.NotificationHubs.Registrations;
using MsgCommander.Contracts.NotificationHubs.Registrations;

namespace MsgCommander.Application.NotificationHubs.Connections;

public sealed class NotificationHubRegistrationContext
{
	public INotificationHubRegistrationsGateway Gateway
	{
		get;
	}
	public NotificationHubRegistrationsConnection Connection
	{
		get;
	}
	public RegistrationSnapshotStore Snapshots { get; } = new();
	public RegistrationBrowsingService Browsing
	{
		get;
	}
	public RegistrationAdministrationService Administration
	{
		get;
	}
	public RegistrationFileService Files
	{
		get;
	}
	public NotificationHubJobService Jobs
	{
		get;
	}

	public NotificationHubRegistrationContext(INotificationHubRegistrationsGateway gateway, NotificationHubRegistrationsConnection connection, IRegistrationFileCodec codec, INotificationHubManagementAccess management, TimeProvider clock)
	{
		Gateway = gateway;
		Connection = connection;
		Browsing = new(gateway, connection, Snapshots, management);
		Administration = new(gateway, Snapshots);
		Files = new(connection, Snapshots, Administration, codec, management, clock);
		Jobs = new(gateway, connection, clock);
	}

	public void Close()
	{
		Browsing.Clear();
		Administration.Clear();
		Files.Clear();
		Jobs.Clear();
		Snapshots.Clear();
	}
}
