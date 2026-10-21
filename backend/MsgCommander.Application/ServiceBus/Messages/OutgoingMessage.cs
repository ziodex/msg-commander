namespace MsgCommander.Application.ServiceBus.Messages;

public sealed class OutgoingMessage
{
	public OutgoingMessage(ReadOnlyMemory<byte> body)
	{
		Body = MessageBody.FromBytes(body);
	}
	public OutgoingMessage(ReceivedMessage original)
	{
		Original = original;
		Body = original.Body;
		MessageId = original.MessageId;
		Subject = original.Subject;
		ContentType = original.ContentType;
		CorrelationId = original.CorrelationId;
		SessionId = original.SessionId;
		ReplyTo = original.ReplyTo;
		ReplyToSessionId = original.ReplyToSessionId;
		To = original.To;
		PartitionKey = original.PartitionKey;
		TransactionPartitionKey = original.TransactionPartitionKey;
		TimeToLive = original.TimeToLive;
		ScheduledEnqueueTime = original.ScheduledEnqueueTime;
		foreach (var property in original.ApplicationProperties)
			ApplicationProperties.Add(property.Key, property.Value);
	}
	public ReceivedMessage? Original
	{
		get;
	}
	public MessageBody Body
	{
		get;
	}
	public string? MessageId
	{
		get; set;
	}
	public string? Subject
	{
		get; set;
	}
	public string? ContentType
	{
		get; set;
	}
	public string? CorrelationId
	{
		get; set;
	}
	public string? SessionId
	{
		get; set;
	}
	public string? ReplyTo
	{
		get; set;
	}
	public string? ReplyToSessionId
	{
		get; set;
	}
	public string? To
	{
		get; set;
	}
	public string? PartitionKey
	{
		get; set;
	}
	public string? TransactionPartitionKey
	{
		get; set;
	}
	public TimeSpan? TimeToLive
	{
		get; set;
	}
	public DateTimeOffset ScheduledEnqueueTime
	{
		get; set;
	}
	public IDictionary<string, object> ApplicationProperties { get; } = new Dictionary<string, object>();
}
