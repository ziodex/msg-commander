using MsgCommander.Application.ServiceBus.Connections;
using MsgCommander.Infrastructure.ServiceBus.Connections;
using MsgCommander.Host.Transport;

namespace MsgCommander.Host;

public static class Program
{
	public static Task<int> Main() => RunAsync(new AzureServiceBusGatewayFactory());
	public static async Task<int> RunAsync(IServiceBusGatewayFactory factory, IEventHubsGatewayFactory? eventHubsFactory = null, IRelayGatewayFactory? relayFactory = null, IHybridGatewayFactory? hybridFactory = null, INotificationHubGatewayFactory? notificationHubsFactory = null, INotificationHubRegistrationsGatewayFactory? registrationsFactory = null, IEventGridGatewayFactory? eventGridFactory = null)
	{
		await using var workspace = new ServiceBusWorkspace(factory);
		await using var eventWorkspace = new EventHubsWorkspace(eventHubsFactory ?? new AzureEventHubsGatewayFactory());
		await using var relayWorkspace = new RelayWorkspace(relayFactory ?? new AzureRelayGatewayFactory());
		await using var notificationHubWorkspace = new NotificationHubWorkspace(notificationHubsFactory ?? new AzureNotificationHubGatewayFactory());
		await using var registrationWorkspace = new NotificationHubRegistrationsWorkspace(registrationsFactory ?? new AzureNotificationHubRegistrationsGatewayFactory(), notificationHubWorkspace);
		await using var notificationSender = new NotificationHubNotificationsWorkspace(registrationsFactory ?? new AzureNotificationHubRegistrationsGatewayFactory(), notificationHubWorkspace);
		await using var hybridWorkspace = new HybridWorkspace(hybridFactory ?? new AzureHybridGatewayFactory());
		await using var gridWorkspace = new EventGridWorkspace(eventGridFactory ?? new AzureEventGridGatewayFactory());
		var commands = new BackendCommandDispatcher(workspace, eventWorkspace, relayWorkspace, notificationHubWorkspace, registrationWorkspace, notificationSender, gridWorkspace, hybridWorkspace, new AzureServiceBusAuthenticationProbe(), new MsgCommander.Infrastructure.Failures.AzureProviderFailureMapper());
		return await new FramedBackendSession(Console.OpenStandardInput(), Console.OpenStandardOutput(), commands.ExecuteAsync).RunAsync();
	}
}
