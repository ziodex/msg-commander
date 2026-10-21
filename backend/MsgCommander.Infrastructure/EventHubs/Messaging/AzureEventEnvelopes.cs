using System.Collections.ObjectModel;
using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Consumer;
using MsgCommander.Application.EventHubs.Messaging;
using MsgCommander.Domain.EventHubs;

namespace MsgCommander.Infrastructure.EventHubs.Messaging;

public sealed class AzureReceivedEvent(EventData message) : ReceivedEvent
{
	public EventData Message { get; } = message;
	public override EventBody EventBody { get; } = new(() => message.EventBody.ToMemory());
	public override long SequenceNumber => Message.SequenceNumber;
	public override string OffsetString => Message.OffsetString;
	public override DateTimeOffset EnqueuedTime => Message.EnqueuedTime;
	public override string? PartitionKey => Message.PartitionKey;
	public override string? MessageId => Message.MessageId;
	public override string? ContentType => Message.ContentType;
	public override string? CorrelationId => Message.CorrelationId;
	public override IReadOnlyDictionary<string, object> Properties { get; } = new ReadOnlyDictionary<string, object>(message.Properties);
	public override IReadOnlyDictionary<string, object> SystemProperties => Message.SystemProperties;
}
public static class AzureOutgoingEvent
{
	public static EventData ToSdk(OutgoingEvent value)
	{
		var data = new EventData(new BinaryData(value.EventBody.ToMemory())) { MessageId = value.MessageId, ContentType = value.ContentType, CorrelationId = value.CorrelationId };
		foreach (var property in value.Properties)
			data.Properties.Add(property.Key, property.Value);
		return data;
	}
}
public static class AzureEventPositions
{
	public static EventPosition ToSdk(StreamPosition value) => value.Kind switch
	{
		StreamPositionKind.Earliest => EventPosition.Earliest,
		StreamPositionKind.Latest => EventPosition.Latest,
		StreamPositionKind.Time => EventPosition.FromEnqueuedTime(DateTimeOffset.Parse(value.Value!, System.Globalization.CultureInfo.InvariantCulture)),
		StreamPositionKind.Sequence => EventPosition.FromSequenceNumber(long.Parse(value.Value!, System.Globalization.CultureInfo.InvariantCulture), value.Inclusive),
		StreamPositionKind.Offset => EventPosition.FromOffset(value.Value!, value.Inclusive),
		_ => throw new ArgumentOutOfRangeException(nameof(value))
	};
}
