using Azure;

namespace MsgCommander.Infrastructure.Relay;

public sealed class AzureRelayFailureClassifier : IRelayFailureClassifier
{
	public RelayFailure Classify(Exception error) => new(error is OperationException or ArgumentException || error is RequestFailedException { Status: 400 or 401 or 403 or 404 or 409 or 412 or 422 or 429 }, error is RequestFailedException { Status: 401 or 403 }, error is RequestFailedException { Status: 404 });
}
