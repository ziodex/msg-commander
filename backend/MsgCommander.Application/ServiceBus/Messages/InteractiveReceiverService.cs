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
using System.Diagnostics;
using MsgCommander.Application.Connections;

namespace MsgCommander.Application.ServiceBus.Messages;

/// <summary>Owns held deliveries and the exclusive session under its connection's operation gate.</summary>
public sealed partial class InteractiveReceiverService : IAsyncDisposable
{
	private readonly IServiceBusMessagingGateway gateway;
	private readonly IMessageFailureClassifier failures;
	private readonly ReceiverOwner<IMessageReceiver, EntityTarget> receiverOwner;
	private readonly Func<EntityTarget, string, string?, long, string?> acknowledgeDeferred;
	private readonly Func<EntityTarget, string, string?, long, string?> recordDeferred;
	private const int SnapshotBudget = MessageInspectionService.SnapshotBudget;
	public InteractiveReceiverService(IServiceBusMessagingGateway gateway, IMessageFailureClassifier failures,
		Func<EntityTarget, string, string?, long, string?> acknowledgeDeferred,
		Func<EntityTarget, string, string?, long, string?> recordDeferred)
	{
		this.gateway = gateway;
		this.failures = failures;
		this.acknowledgeDeferred = acknowledgeDeferred;
		this.recordDeferred = recordDeferred;
		receiverOwner = new(ResetReceiverState);
	}
	public bool HasReceiver => ownedReceiver is not null;
	public EntityTarget? Target => receivedTarget;
	private sealed class Held(ReceivedMessage message, MessageSummary summary)
	{
		public ReceivedMessage Message { get; } = message;
		public MessageSummary Summary { get; } = summary;
		public string State { get; set; } = "active";
	}
	private IMessageReceiver? ownedReceiver => receiverOwner.Current;
	private EntityTarget? receivedTarget => receiverOwner.Address?.Target;
	private string receivedSubQueue => receiverOwner.Address?.SubQueue ?? "active";
	private string? receivedSession => receiverOwner.Address?.SessionId;
	private string? receiveWarning;
	private readonly Dictionary<string, Held> deliveries = [];

	public Deliveries CurrentDeliveries()
	{
		var session = CurrentSession();
		foreach (var held in deliveries.Values)
			if (held.State == "active" && ownedReceiver!.LockedUntil(held.Message) <= DateTimeOffset.UtcNow)
				held.State = "lock-lost";
		return new(receivedTarget, receivedSubQueue, receivedSession, deliveries.Select(pair => new DeliveryInfo(pair.Key, pair.Value.Summary, Timestamp(ownedReceiver!.LockedUntil(pair.Value.Message)), pair.Value.State)).ToArray(), receiveWarning, session);
	}
	private void ResetReceiverState()
	{
		deliveries.Clear();
		receiveWarning = null;
		TrackSession();
	}
	public ValueTask DisposeAsync() => receiverOwner.DisposeAsync();
	public async Task<Deliveries> ReceiveAsync(ReceiveMessages request, CancellationToken cancellation)
	{
		CurrentDeliveries();
		if (deliveries.Values.Any(value => value.State is "active" or "unknown"))
			throw new OperationException(OperationFailure.OperationBlocked, "Settle the current batch or close its receiver before receiving another batch.");
		var target = request.Target;
		target.Validate(peek: true);
		var subQueue = request.SubQueue;
		var sessionId = request.SessionId!;
		var count = request.MaxMessages;
		var seconds = request.WaitSeconds;
		long? deferred = null;
		if (request.DeferredSequence is string sequence)
		{
			if (!long.TryParse(sequence, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var value) || value < 0)
				throw new OperationException(OperationFailure.InvalidInput, "Use a nonnegative Int64 deferred sequence number.");
			deferred = value;
			count = 1;
		}
		if (subQueue is not ("active" or "dead-letter" or "transfer-dead-letter") || sessionId.Length > 128 || count is < 1 or > 10 || seconds is < 1 or > 20)
			throw new OperationException(OperationFailure.InvalidInput, "Receive 1–10 messages with a wait budget of 1–20 seconds.");
		if (subQueue != "active" && sessionId.Length > 0)
			throw new OperationException(OperationFailure.InvalidInput, "Dead-letter subqueues use a regular receiver without a session filter.");
		var lease = CurrentSession();
		var requestedLease = request.SessionLeaseId;
		if (requestedLease is not null)
			RequireSession(requestedLease);
		if (lease is not null)
		{
			RequireSession(lease.LeaseId);
			if (subQueue != "active" || lease.Target != target || lease.SessionId != sessionId)
				throw new OperationException(OperationFailure.OperationBlocked, "Release the owned session before receiving from another source.");
			deliveries.Clear();
			receiveWarning = null; // Retain this exclusive session receiver across settled batches.
		}
		else
		{
			await DisposeAsync();
			await receiverOwner.OpenAsync(new(target, subQueue!, string.IsNullOrEmpty(sessionId) ? null : sessionId),
				token => gateway!.OpenReceiverAsync(target, subQueue!, sessionId, token), cancellation);
			TrackSession();
		}
		var timer = Stopwatch.StartNew();
		long retained = 0;
		try
		{
			for (var i = 0; i < count; i++)
			{
				cancellation.ThrowIfCancellationRequested();
				var remaining = TimeSpan.FromSeconds(seconds) - timer.Elapsed;
				if (remaining <= TimeSpan.Zero)
					break;
				// Fetch one at a time so a large body cannot multiply into ten unbounded retained messages.
				IReadOnlyList<ReceivedMessage> received = deferred is long from
					? [await ownedReceiver!.ReceiveDeferredAsync(from, cancellation)]
					: await ownedReceiver!.ReceiveAsync(1, remaining, cancellation);
				if (received.Count == 0)
					break;
				var message = received[0];
				var deliveryId = Guid.NewGuid().ToString();
				int size = 0;
				string? warning = null;
				try
				{
					size = message.Body.ToMemory().Length;
				}
				catch (NotSupportedException) { warning = "Unsupported AMQP body form. Settlement is still available."; }
				if (size > SnapshotBudget)
					warning = "Body exceeds the 64 MiB inspector limit. Settlement is still available.";
				var summary = Summary(message, warning is null ? deliveryId : null, size, warning);
				// Bound summary metadata independently of untrusted AMQP strings. Full properties are inspected separately.
				summary = summary with
				{
					Subject = Short(summary.Subject, 512),
					ContentType = Short(summary.ContentType, 128),
					MessageId = Short(summary.MessageId, 128),
					SessionId = Short(summary.SessionId, 128)
				};
				deliveries.Add(deliveryId, new(message, summary));
				if (deferred.HasValue)
					receiveWarning = acknowledgeDeferred(target, subQueue!, receivedSession, message.SequenceNumber);
				retained += size;
				if (warning is not null || retained >= SnapshotBudget)
				{
					receiveWarning = "Receive stopped at the inspection budget. The last message remains held for an explicit settlement action.";
					break;
				}
			}
		}
		catch (Exception error)
		{
			if (failures.Classify(error).Kind == MessageFailureKind.SessionLockLost)
			{
				sessionLockLost = true;
				CurrentSession();
			}
			receiveWarning = "Receive was interrupted. Any displayed messages remain held; unreported broker deliveries may stay locked until expiry. Refresh held messages before continuing.";
			throw;
		}
		return CurrentDeliveries();
	}
	private static string? Short(string? value, int max) => value?.Length > max ? value[..max] : value;


	public (ReceivedMessage Message, ReadOnlyMemory<byte> Body, MessageSummary Summary)? FindSnapshot(string id)
	{
		if (!deliveries.TryGetValue(id, out var delivery))
			return null;
		if (delivery.Summary.SnapshotId is null)
			throw new OperationException(OperationFailure.InspectionLimit, "This received body exceeds the local inspection limit or has an unsupported format.");
		return (delivery.Message, delivery.Message.Body.ToMemory(), delivery.Summary);
	}
}
