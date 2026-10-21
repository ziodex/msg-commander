using System.Globalization;
using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Messages;
using MsgCommander.Contracts.ServiceBus.Sessions;
using MsgCommander.Domain.ServiceBus.Messages;
using static MsgCommander.Application.Common.DisplayValues;
using static MsgCommander.Application.ServiceBus.Messages.MessageProjection;

namespace MsgCommander.Application.ServiceBus.Messages;

// Serialized by the connection operation gate. A failed page never replaces the current snapshots.
public sealed class MessageInspectionService(IServiceBusMessagingGateway gateway,
	Func<string, (ReceivedMessage Message, ReadOnlyMemory<byte> Body, MessageSummary Summary)?> externalSnapshot)
{
	public const int SnapshotBudget = 64 * 1024 * 1024;
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	private Dictionary<string, (ReceivedMessage Message, ReadOnlyMemory<byte> Body, MessageSummary Summary)> snapshots = [];
	public void Clear() => snapshots.Clear();
	public async Task<PeekPage> PeekAsync(PeekMessages request, CancellationToken cancellation)
	{
		var target = request.Target;
		var scheduled = request.Scheduled;
		if (scheduled)
			OutgoingMessages.ValidateDestination(target);
		else
			target.Validate(peek: true);
		var subQueue = scheduled ? "active" : request.SubQueue;
		if (subQueue is not ("active" or "dead-letter" or "transfer-dead-letter"))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid subqueue.");
		if (!long.TryParse(request.FromSequenceNumber, NumberStyles.None, CultureInfo.InvariantCulture, out var sequence) || sequence < 0)
			throw new OperationException(OperationFailure.InvalidInput, "Invalid sequence number.");
		var limit = request.MaxMessages;
		if (limit is < 1 or > 25)
			throw new OperationException(OperationFailure.InvalidInput, "Peek between 1 and 25 messages per page.");
		Dictionary<string, (ReceivedMessage Message, ReadOnlyMemory<byte> Body, MessageSummary Summary)> nextSnapshots = [];
		List<MessageSummary> summaries = [];
		long? nextSequence = sequence;
		var retained = 0;
		var metadataBytes = 0;
		string? warning = null;
		for (var index = 0; index < limit && nextSequence is not null; index++)
		{
			cancellation.ThrowIfCancellationRequested();
			var message = await gateway!.PeekOneAsync(target, subQueue, nextSequence.Value, cancellation);
			if (message is null)
				break; // Short pages are not a stable end-of-log guarantee; the cursor remains refreshable.
			if (message.SequenceNumber < nextSequence.Value)
				throw new OperationException(OperationFailure.InvalidBrokerSequence, "The broker returned a sequence before the requested cursor. Restart peeking.");
			if (scheduled && message.State != MessageState.Scheduled)
			{
				nextSequence = message.SequenceNumber == long.MaxValue ? null : message.SequenceNumber + 1;
				continue;
			}
			ReadOnlyMemory<byte> body = ReadOnlyMemory<byte>.Empty;
			string? inspectionWarning = null;
			try
			{
				body = message.Body.ToMemory();
			}
			catch (NotSupportedException)
			{
				inspectionWarning = "This AMQP body format is not supported by the byte inspector; its byte size is unknown.";
			}
			if (body.Length > SnapshotBudget)
			{
				inspectionWarning = "This message exceeds the 64 MiB local inspection limit. It was not changed.";
				warning = "One or more message bodies exceed the local inspection limit.";
			}
			var id = inspectionWarning is null ? Guid.NewGuid().ToString() : null;
			var summary = Summary(message, id, body.Length, inspectionWarning);
			var projectedBytes = JsonSerializer.SerializeToUtf8Bytes(summary, Json).Length;
			if (projectedBytes > 700_000)
				throw new OperationException(OperationFailure.InspectionLimit, "Message summary exceeds the local metadata limit. The message was not changed.");
			if ((id is not null && retained + body.Length > SnapshotBudget) || metadataBytes + projectedBytes > 700_000)
			{
				warning = "The local page limit was reached. Peek next to continue from the first omitted message.";
				break;
			}
			metadataBytes += projectedBytes;
			if (id is not null)
			{
				retained += body.Length;
				nextSnapshots.Add(id, (message, body, summary));
			}
			summaries.Add(summary);
			nextSequence = message.SequenceNumber == long.MaxValue ? null : message.SequenceNumber + 1;
		}
		cancellation.ThrowIfCancellationRequested();
		snapshots = nextSnapshots; // Failed/cancelled peeks preserve the previous page's snapshots.
		return new(summaries, nextSequence is null ? null : Number(nextSequence.Value), warning, Timestamp(DateTimeOffset.UtcNow));
	}

	public (ReceivedMessage Message, ReadOnlyMemory<byte> Body, MessageSummary Summary) Snapshot(string id)
	{
		if (externalSnapshot(id) is { } external)
			return external;
		if (!snapshots.TryGetValue(id, out var result))
			throw new OperationException(OperationFailure.SnapshotExpired, "This message snapshot expired. Consumed messages cannot be fetched again.");
		return result;
	}
	public MessageDetails Inspect(string id)
	{
		var snapshot = Snapshot(id);
		var details = Details(snapshot.Message, snapshot.Summary);
		if (JsonSerializer.SerializeToUtf8Bytes(details, Json).Length > 900_000)
			throw new OperationException(OperationFailure.InspectionLimit, "Message properties exceed the inspector's 900 KB response limit. The message was not changed.");
		return details;
	}
	public BodyChunk Body(string id, int offset, int count)
	{
		var body = Snapshot(id).Body;
		if (offset < 0 || offset > body.Length || count is < 1 or > 65536)
			throw new OperationException(OperationFailure.InvalidInput, "Invalid body range.");
		var length = Math.Min(count, body.Length - offset);
		return new(Convert.ToBase64String(body.Span.Slice(offset, length)), offset, body.Length, offset + length < body.Length ? offset + length : null);
	}
}
