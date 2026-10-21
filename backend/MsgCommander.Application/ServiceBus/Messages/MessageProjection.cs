using static MsgCommander.Application.Common.DisplayValues;
using System.Globalization;
using MsgCommander.Domain.ServiceBus.Messages;
using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.ServiceBus.Messages;

namespace MsgCommander.Application.ServiceBus.Messages;

public static class MessageProjection
{
	public static MessageSummary Summary(ReceivedMessage message, string? snapshotId, int bodySize, string? warning = null) => new(snapshotId, Number(message.SequenceNumber), message.MessageId, message.Subject, message.ContentType, Timestamp(message.EnqueuedTime), message.State.ToString(), message.DeliveryCount, message.SessionId, bodySize, warning, message.State == MessageState.Scheduled ? Timestamp(message.ScheduledEnqueueTime) : null);
	public static MessageDetails Details(ReceivedMessage message, MessageSummary summary) => new(summary, [Property("SequenceNumber", message.SequenceNumber), Property("EnqueuedSequenceNumber", message.EnqueuedSequenceNumber), Property("MessageId", message.MessageId), Property("CorrelationId", message.CorrelationId), Property("Subject", message.Subject), Property("ContentType", message.ContentType), Property("State", message.State.ToString()), Property("SessionId", message.SessionId), Property("ReplyToSessionId", message.ReplyToSessionId), Property("To", message.To), Property("ReplyTo", message.ReplyTo), Property("PartitionKey", message.PartitionKey), Property("TransactionPartitionKey", message.TransactionPartitionKey), Property("DeliveryCount", message.DeliveryCount), Property("EnqueuedTime", message.EnqueuedTime), Property("ScheduledEnqueueTime", message.ScheduledEnqueueTime), Property("ExpiresAt", message.ExpiresAt), Property("TimeToLive", message.TimeToLive), Property("DeadLetterReason", message.DeadLetterReason), Property("DeadLetterErrorDescription", message.DeadLetterErrorDescription), Property("DeadLetterSource", message.DeadLetterSource)], message.ApplicationProperties.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => Property(pair.Key, pair.Value)).ToArray());
}
