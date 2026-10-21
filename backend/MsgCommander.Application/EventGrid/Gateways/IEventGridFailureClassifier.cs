namespace MsgCommander.Application.EventGrid.Gateways;

public enum EventGridFailureOperation
{
	Administration, Publish, Pull
}
public sealed record EventGridFailure(bool Rejected, bool Denied);
public interface IEventGridFailureClassifier
{
	EventGridFailure Classify(Exception error, EventGridFailureOperation operation);
}
