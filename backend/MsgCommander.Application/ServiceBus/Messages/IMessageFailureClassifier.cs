namespace MsgCommander.Application.ServiceBus.Messages;

public enum MessageFailureKind
{
	Other, MessageLockLost, SessionLockLost, Timeout, SessionUnavailable, EntityNotFound, EntityDisabled,
}
public sealed record MessageFailure(MessageFailureKind Kind, bool IsRequestRejected = false);

/// <summary>Classifies external failures without making workflows depend on a broker SDK.</summary>
public interface IMessageFailureClassifier
{
	MessageFailure Classify(Exception error);
}

public sealed class MessageFailureException(MessageFailureKind kind, string safeMessage) : Exception(safeMessage)
{
	public MessageFailureKind Kind { get; } = kind;
}
