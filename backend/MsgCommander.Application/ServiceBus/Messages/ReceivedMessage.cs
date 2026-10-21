using MsgCommander.Domain.ServiceBus.Messages;

namespace MsgCommander.Application.ServiceBus.Messages;

/// <summary>Read-only broker data. A delivery's settlement ownership stays with its receiver.</summary>
public abstract class ReceivedMessage
{
	public abstract MessageBody Body
	{
		get;
	}
	public abstract long SequenceNumber
	{
		get;
	}
	public abstract long EnqueuedSequenceNumber
	{
		get;
	}
	public abstract string? MessageId
	{
		get;
	}
	public abstract string? CorrelationId
	{
		get;
	}
	public abstract string? Subject
	{
		get;
	}
	public abstract string? ContentType
	{
		get;
	}
	public abstract string? SessionId
	{
		get;
	}
	public abstract string? ReplyToSessionId
	{
		get;
	}
	public abstract string? To
	{
		get;
	}
	public abstract string? ReplyTo
	{
		get;
	}
	public abstract string? PartitionKey
	{
		get;
	}
	public abstract string? TransactionPartitionKey
	{
		get;
	}
	public abstract int DeliveryCount
	{
		get;
	}
	public abstract DateTimeOffset EnqueuedTime
	{
		get;
	}
	public abstract DateTimeOffset ScheduledEnqueueTime
	{
		get;
	}
	public abstract DateTimeOffset ExpiresAt
	{
		get;
	}
	public abstract DateTimeOffset LockedUntil
	{
		get;
	}
	public abstract TimeSpan TimeToLive
	{
		get;
	}
	public abstract string? DeadLetterReason
	{
		get;
	}
	public abstract string? DeadLetterErrorDescription
	{
		get;
	}
	public abstract string? DeadLetterSource
	{
		get;
	}
	public abstract MessageState State
	{
		get;
	}
	public abstract IReadOnlyDictionary<string, object> ApplicationProperties
	{
		get;
	}
}
