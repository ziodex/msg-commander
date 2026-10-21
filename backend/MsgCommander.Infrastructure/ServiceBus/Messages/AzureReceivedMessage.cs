using Azure.Messaging.ServiceBus;
using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Domain.ServiceBus.Messages;

namespace MsgCommander.Infrastructure.ServiceBus.Messages;

public sealed class AzureReceivedMessage : ReceivedMessage
{
	private AzureReceivedMessage(ServiceBusReceivedMessage message, object? owner)
	{
		Message = message;
		Owner = owner;
		Body = new AzureBody(message);
	}
	internal ServiceBusReceivedMessage Message
	{
		get;
	}
	internal object? Owner
	{
		get;
	}
	internal bool Settled
	{
		get; set;
	}
	internal SemaphoreSlim SettlementGate { get; } = new(1);
	public static ReceivedMessage Snapshot(ServiceBusReceivedMessage message) => new AzureReceivedMessage(message, null);
	internal static AzureReceivedMessage Delivery(ServiceBusReceivedMessage message, object owner) => new(message, owner);
	private sealed class AzureBody(ServiceBusReceivedMessage message) : MessageBody
	{
		public override ReadOnlyMemory<byte> ToMemory() => message.Body.ToMemory();
	}
	public override MessageBody Body
	{
		get;
	}
	public override long SequenceNumber => Message.SequenceNumber;
	public override long EnqueuedSequenceNumber => Message.EnqueuedSequenceNumber;
	public override string? MessageId => Message.MessageId;
	public override string? CorrelationId => Message.CorrelationId;
	public override string? Subject => Message.Subject;
	public override string? ContentType => Message.ContentType;
	public override string? SessionId => Message.SessionId;
	public override string? ReplyToSessionId => Message.ReplyToSessionId;
	public override string? To => Message.To;
	public override string? ReplyTo => Message.ReplyTo;
	public override string? PartitionKey => Message.PartitionKey;
	public override string? TransactionPartitionKey => Message.TransactionPartitionKey;
	public override int DeliveryCount => Message.DeliveryCount;
	public override DateTimeOffset EnqueuedTime => Message.EnqueuedTime;
	public override DateTimeOffset ScheduledEnqueueTime => Message.ScheduledEnqueueTime;
	public override DateTimeOffset ExpiresAt => Message.ExpiresAt;
	public override DateTimeOffset LockedUntil => Message.LockedUntil;
	public override TimeSpan TimeToLive => Message.TimeToLive;
	public override string? DeadLetterReason => Message.DeadLetterReason;
	public override string? DeadLetterErrorDescription => Message.DeadLetterErrorDescription;
	public override string? DeadLetterSource => Message.DeadLetterSource;
	public override MessageState State => Message.State switch
	{
		ServiceBusMessageState.Active => MessageState.Active,
		ServiceBusMessageState.Deferred => MessageState.Deferred,
		ServiceBusMessageState.Scheduled => MessageState.Scheduled,
		_ => throw new NotSupportedException("Unsupported broker message state."),
	};
	public override IReadOnlyDictionary<string, object> ApplicationProperties => Message.ApplicationProperties;
}
