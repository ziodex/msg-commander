namespace MsgCommander.Application.EventHubs.Messaging;

public sealed class EventBody(Func<ReadOnlyMemory<byte>> read)
{
	public ReadOnlyMemory<byte> ToMemory() => read();
	public byte[] ToArray() => ToMemory().ToArray();
	public override string ToString() => System.Text.Encoding.UTF8.GetString(ToMemory().Span);
	public static EventBody FromBytes(ReadOnlyMemory<byte> bytes) => new(() => bytes);
}
public abstract class ReceivedEvent
{
	public abstract EventBody EventBody
	{
		get;
	}
	public abstract long SequenceNumber
	{
		get;
	}
	public abstract string OffsetString
	{
		get;
	}
	public abstract DateTimeOffset EnqueuedTime
	{
		get;
	}
	public abstract string? PartitionKey
	{
		get;
	}
	public abstract string? MessageId
	{
		get;
	}
	public abstract string? ContentType
	{
		get;
	}
	public abstract string? CorrelationId
	{
		get;
	}
	public abstract IReadOnlyDictionary<string, object> Properties
	{
		get;
	}
	public abstract IReadOnlyDictionary<string, object> SystemProperties
	{
		get;
	}
}
public sealed class OutgoingEvent(EventBody body, string messageId)
{
	public EventBody EventBody { get; } = body;
	public string MessageId { get; } = messageId;
	public string? ContentType
	{
		get; set;
	}
	public string? CorrelationId
	{
		get; set;
	}
	public Dictionary<string, object> Properties { get; } = [];
}
