using MsgCommander.Application.NotificationHubs.Gateways;
using MsgCommander.Application.NotificationHubs.Notifications;
using MsgCommander.Contracts.NotificationHubs.Registrations;

namespace MsgCommander.Application.NotificationHubs.Connections;

public sealed class NotificationHubSenderContext(INotificationHubRegistrationsGateway gateway, NotificationHubRegistrationsConnection connection, TimeProvider clock)
{
	public INotificationHubRegistrationsGateway Gateway { get; } = gateway;
	public NotificationHubRegistrationsConnection Connection { get; } = connection;
	public NotificationSendService Sending { get; } = new(gateway, clock);

	public void Close() => Sending.Clear();
}
