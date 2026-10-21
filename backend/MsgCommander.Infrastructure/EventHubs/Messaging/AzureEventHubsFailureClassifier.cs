using Azure;
using Azure.Identity;
using Azure.Messaging.EventHubs;
using MsgCommander.Application.Common;
namespace MsgCommander.Infrastructure.EventHubs.Messaging;

public sealed class AzureEventHubsFailureClassifier : IEventHubsFailureClassifier
{
	public EventFailure Classify(Exception error, EventFailureOperation operation)
	{
		var rejected = error is OperationException or ArgumentException;
		if (operation == EventFailureOperation.Send)
			rejected |= error is UnauthorizedAccessException or System.Runtime.Serialization.SerializationException ||
			error is EventHubsException { Reason: EventHubsException.FailureReason.MessageSizeExceeded or EventHubsException.FailureReason.ResourceNotFound };
		else
			rejected |= error is RequestFailedException { Status: 400 or 401 or 403 or 404 or 409 or 412 or 422 or 429 };
		return new(rejected, error is RequestFailedException { Status: 401 or 403 }, error is RequestFailedException { Status: 404 });
	}
	public bool IsIotAccessFailure(Exception error) => error is UnauthorizedAccessException or AuthenticationFailedException or RequestFailedException or EventHubsException;
}
