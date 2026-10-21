using Azure;
using MsgCommander.Application.ServiceBus.Administration;

namespace MsgCommander.Infrastructure.ServiceBus.Administration;

public sealed class AzureAdministrationFailureClassifier : IAdministrationFailureClassifier
{
	public AdministrationFailure Classify(Exception error)
	{
		var request = error as RequestFailedException ?? error.InnerException as RequestFailedException;
		return new(request?.Status is 400 or 401 or 403 or 404 or 409 or 412,
			request?.Status is 401 or 403, request?.Status == 404);
	}
}
