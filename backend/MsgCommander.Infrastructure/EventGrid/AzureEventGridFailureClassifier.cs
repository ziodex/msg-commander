using Azure;
using Azure.Identity;

namespace MsgCommander.Infrastructure.EventGrid;

public sealed class AzureEventGridFailureClassifier : IEventGridFailureClassifier
{
	public EventGridFailure Classify(Exception error, EventGridFailureOperation operation)
	{
		var rejected = operation == EventGridFailureOperation.Administration
			? error is RequestFailedException { Status: 400 or 401 or 403 or 404 or 409 or 412 or 422 or 429 }
			: error is RequestFailedException { Status: 400 or 401 or 403 or 404 or 405 or 409 or 413 or 415 or 422 or 429 };
		if (operation == EventGridFailureOperation.Publish)
			rejected |= error is OperationException or UnauthorizedAccessException or AuthenticationFailedException;
		return new(rejected, error is RequestFailedException { Status: 401 or 403 });
	}
}
