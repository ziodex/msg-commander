using Azure.Messaging.ServiceBus;
using MsgCommander.Application.ServiceBus.TestJobs;

namespace MsgCommander.Infrastructure.ServiceBus.TestJobs;

public static class TestJobFailureMapper
{
	public static Exception Translate(Exception error)
	{
		if (error is ServiceBusException broker)
		{
			var rejected = broker.Reason is ServiceBusFailureReason.MessageLockLost or ServiceBusFailureReason.SessionLockLost or
				ServiceBusFailureReason.MessagingEntityNotFound or ServiceBusFailureReason.MessagingEntityDisabled or
				ServiceBusFailureReason.MessageSizeExceeded or ServiceBusFailureReason.SessionCannotBeLocked;
			return new TestJobTransportException(rejected, ServiceBusFailures.Describe(broker));
		}
		if (error is Azure.RequestFailedException request)
			return new TestJobTransportException(request.Status is 400 or 401 or 403 or 404, "Access or broker error. Nothing was retried.");
		return error;
	}
}
