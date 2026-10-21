using Azure;
using Azure.Identity;
using Azure.Messaging.ServiceBus;
using MsgCommander.Infrastructure.Failures;

static class ProviderFailureMappingChecks
{
	public static int Run()
	{
		var mapper = new AzureProviderFailureMapper();
		var checks = new (Exception Error, string Method, OperationFailure Failure)[]
		{
			(new AuthenticationFailedException("SECRET"), "auth.test", OperationFailure.AuthenticationRequired),
			(new RequestFailedException(403, "SECRET"), "eg.get", OperationFailure.AuthenticationRequired),
			(new RequestFailedException(403, "SECRET"), "nh.get", OperationFailure.AuthenticationRequired),
			(new RequestFailedException(403, "SECRET"), "relay.get", OperationFailure.AuthenticationRequired),
			(new RequestFailedException(403, "SECRET"), "eh.get", OperationFailure.AuthenticationRequired),
			(new RequestFailedException(403, "SECRET"), "sb.authorization.list", OperationFailure.AuthenticationRequired),
			(new RequestFailedException(404, "SECRET"), "sb.list", OperationFailure.ResourceNotFound),
			(new RequestFailedException(403, "SECRET"), "sb.list", OperationFailure.AuthenticationRequired),
			(new RequestFailedException(429, "SECRET"), "sb.list", OperationFailure.TransportUnavailable),
			(new UnauthorizedAccessException("SECRET"), "eh.read", OperationFailure.AuthenticationRequired),
			(new UnauthorizedAccessException("SECRET"), "sb.session.accept", OperationFailure.AuthenticationRequired),
			(new UnauthorizedAccessException("SECRET"), "sb.peek", OperationFailure.AuthenticationRequired),
			(new NotSupportedException("SECRET"), "sb.session.list", OperationFailure.UnsupportedOperation),
			(new ServiceBusException("SECRET", ServiceBusFailureReason.MessagingEntityNotFound), "sb.receive", OperationFailure.ResourceNotFound),
			(new ServiceBusException("SECRET", ServiceBusFailureReason.SessionCannotBeLocked), "sb.session.accept", OperationFailure.SessionLockUnavailable),
			(new ServiceBusException("SECRET", ServiceBusFailureReason.SessionLockLost), "sb.session.renew", OperationFailure.SessionLockUnavailable),
			(new ServiceBusException("SECRET", ServiceBusFailureReason.MessageNotFound), "sb.deferred.receive", OperationFailure.DeferredMessageUnavailable),
			(new ServiceBusException("SECRET", ServiceBusFailureReason.ServiceCommunicationProblem), "sb.receive", OperationFailure.TransportUnavailable),
		};
		foreach (var check in checks)
		{
			var result = mapper.Map(check.Error, check.Method);
			if (result?.Failure != check.Failure || result.Message.Contains("SECRET"))
				throw new Exception("Provider classification or redaction regressed: " + check.Method);
		}
		if (mapper.Map(new IOException("SECRET"), "sb.receive") is not null)
			throw new Exception("Unknown failures must remain unclassified");
		Console.WriteLine("Provider failure mapping checks passed");
		return 0;
	}
}
