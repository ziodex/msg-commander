namespace MsgCommander.Application.ServiceBus.Administration;

public sealed record AdministrationFailure(bool IsRejected = false, bool IsPermissionDenied = false, bool IsNotFound = false);

public interface IAdministrationFailureClassifier
{
	AdministrationFailure Classify(Exception error);
}
