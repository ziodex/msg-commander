namespace MsgCommander.Application.EventHubs.Messaging;

public enum EventFailureOperation
{
	Send, Administration
}
public sealed record EventFailure(bool Rejected, bool Denied = false, bool NotFound = false);
public interface IEventHubsFailureClassifier
{
	EventFailure Classify(Exception error, EventFailureOperation operation);
	bool IsIotAccessFailure(Exception error);
}
