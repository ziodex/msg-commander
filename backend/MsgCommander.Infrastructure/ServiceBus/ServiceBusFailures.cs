using Azure.Messaging.ServiceBus;

namespace MsgCommander.Infrastructure.ServiceBus;

// SDK exception text can contain endpoint or credential data; expose only known categories.
public static class ServiceBusFailures
{
	public static string Describe(ServiceBusException error) => error.Reason switch
	{
		ServiceBusFailureReason.ServiceBusy => "The broker is busy or throttling. Reduce the rate before another job.",
		ServiceBusFailureReason.ServiceCommunicationProblem => "The broker connection was interrupted. Review outcomes before reconnecting.",
		ServiceBusFailureReason.ServiceTimeout => "The broker did not respond before the timeout. Review outcomes before another attempt.",
		ServiceBusFailureReason.QuotaExceeded => "A broker quota was exceeded. Check entity capacity and connection limits.",
		_ => "Service Bus operation failed. Check the endpoint, network and messaging permissions."
	};
}
