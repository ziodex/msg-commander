namespace MsgCommander.Infrastructure.ServiceBus;

public sealed partial class AzureServiceBusGateway
{
	public ITestMessageSender OpenTestSender(EntityTarget target)
	{
		OutgoingMessages.ValidateDestination(target);
		return new AzureTestMessageSender(messaging.CreateSender(target.Name));
	}
}
