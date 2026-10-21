using Azure.Messaging.ServiceBus;
using MsgCommander.Application.ServiceBus.Messages;

namespace MsgCommander.Infrastructure.ServiceBus.Messages;

public sealed class AzureMessageFailureClassifier : IMessageFailureClassifier
{
	public MessageFailure Classify(Exception error) => error switch
	{
		MessageFailureException known => new(known.Kind),
		ServiceBusException broker => new(broker.Reason switch
		{
			ServiceBusFailureReason.MessageLockLost => MessageFailureKind.MessageLockLost,
			ServiceBusFailureReason.SessionLockLost => MessageFailureKind.SessionLockLost,
			ServiceBusFailureReason.ServiceTimeout => MessageFailureKind.Timeout,
			ServiceBusFailureReason.SessionCannotBeLocked => MessageFailureKind.SessionUnavailable,
			ServiceBusFailureReason.MessagingEntityNotFound => MessageFailureKind.EntityNotFound,
			ServiceBusFailureReason.MessagingEntityDisabled => MessageFailureKind.EntityDisabled,
			_ => MessageFailureKind.Other,
		}),
		Azure.RequestFailedException request => new(MessageFailureKind.Other,
			request.Status is 400 or 401 or 403 or 404 or 409 or 412),
		_ => new(MessageFailureKind.Other),
	};
}
