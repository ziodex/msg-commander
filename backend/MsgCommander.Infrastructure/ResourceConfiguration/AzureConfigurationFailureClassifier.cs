using Azure;
using Azure.Messaging.ServiceBus;
using MsgCommander.Application.ResourceConfiguration;

namespace MsgCommander.Infrastructure.ResourceConfiguration;

public sealed class AzureConfigurationFailureClassifier : IConfigurationFailureClassifier
{
	public ConfigurationFailure Classify(Exception error) => error switch
	{
		RequestFailedException request => new(request.Status == 404,
			request.Status is 400 or 401 or 403 or 404 or 409 or 412 or 422 or 429),
		ServiceBusException broker => new(broker.Reason == ServiceBusFailureReason.MessagingEntityNotFound,
			broker.Reason is ServiceBusFailureReason.MessagingEntityNotFound or ServiceBusFailureReason.MessagingEntityAlreadyExists or
				ServiceBusFailureReason.MessagingEntityDisabled or ServiceBusFailureReason.MessageSizeExceeded or ServiceBusFailureReason.QuotaExceeded),
		_ => new(),
	};
}
