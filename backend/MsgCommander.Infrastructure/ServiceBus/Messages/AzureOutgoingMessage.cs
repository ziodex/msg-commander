using Azure.Messaging.ServiceBus;
using MsgCommander.Application.ServiceBus.Messages;

namespace MsgCommander.Infrastructure.ServiceBus.Messages;

public static class AzureOutgoingMessage
{
	public static ServiceBusMessage ToSdk(OutgoingMessage value)
	{
		// Preserve the original AMQP body form and typed metadata when copying a snapshot.
		var message = value.Original is null ? new ServiceBusMessage(new BinaryData(value.Body.ToMemory())) :
			value.Original is AzureReceivedMessage original ? new ServiceBusMessage(original.Message) :
			throw new InvalidOperationException("The received message does not belong to the Azure adapter.");
		if (value.MessageId is not null)
			message.MessageId = value.MessageId;
		if (value.Original is not { } source)
		{
			message.Subject = value.Subject;
			message.ContentType = value.ContentType;
			message.CorrelationId = value.CorrelationId;
			message.SessionId = value.SessionId;
			message.ReplyTo = value.ReplyTo;
			message.ReplyToSessionId = value.ReplyToSessionId;
			message.To = value.To;
			// An absent partition key must stay absent for a session-only message.
			if (value.PartitionKey is not null)
				message.PartitionKey = value.PartitionKey;
			if (value.TimeToLive is { } ttl)
				message.TimeToLive = ttl;
		}
		else
		{
			// Leave unchanged native headers intact, including AMQP identifiers with non-string types.
			if (value.Subject != source.Subject)
				message.Subject = value.Subject;
			if (value.ContentType != source.ContentType)
				message.ContentType = value.ContentType;
			if (value.CorrelationId != source.CorrelationId)
				message.CorrelationId = value.CorrelationId;
			if (value.SessionId != source.SessionId)
				message.SessionId = value.SessionId;
			if (value.ReplyTo != source.ReplyTo)
				message.ReplyTo = value.ReplyTo;
			if (value.ReplyToSessionId != source.ReplyToSessionId)
				message.ReplyToSessionId = value.ReplyToSessionId;
			if (value.To != source.To)
				message.To = value.To;
			if (value.PartitionKey != source.PartitionKey)
				message.PartitionKey = value.PartitionKey;
			if (value.TimeToLive is { } ttl && ttl != source.TimeToLive)
				message.TimeToLive = ttl;
		}
		message.TransactionPartitionKey = value.TransactionPartitionKey;
		message.ScheduledEnqueueTime = value.ScheduledEnqueueTime;
		foreach (var name in message.ApplicationProperties.Keys.Except(value.ApplicationProperties.Keys).ToArray())
			message.ApplicationProperties.Remove(name);
		foreach (var property in value.ApplicationProperties)
		{
			// Keep the SDK clone's omission of broker/diagnostic properties unless explicitly changed.
			if (value.Original?.ApplicationProperties.TryGetValue(property.Key, out var previous) == true &&
				Equals(previous, property.Value) && !message.ApplicationProperties.ContainsKey(property.Key))
				continue;
			message.ApplicationProperties[property.Key] = property.Value;
		}
		return message;
	}
	public static OutgoingMessage FromSdk(ServiceBusMessage value)
	{
		var message = new OutgoingMessage(value.Body.ToMemory())
		{
			MessageId = value.MessageId,
			Subject = value.Subject,
			ContentType = value.ContentType,
			CorrelationId = value.CorrelationId,
			SessionId = value.SessionId,
			ReplyTo = value.ReplyTo,
			ReplyToSessionId = value.ReplyToSessionId,
			To = value.To,
			PartitionKey = value.PartitionKey,
			TransactionPartitionKey = value.TransactionPartitionKey,
			TimeToLive = value.GetRawAmqpMessage().Header.TimeToLive,
			ScheduledEnqueueTime = value.ScheduledEnqueueTime
		};
		foreach (var property in value.ApplicationProperties)
			message.ApplicationProperties.Add(property.Key, property.Value);
		return message;
	}
}
