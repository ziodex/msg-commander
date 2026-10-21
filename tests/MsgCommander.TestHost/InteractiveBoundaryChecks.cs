using System.Runtime.CompilerServices;
using Azure.Messaging.ServiceBus;
using MsgCommander.Application.ServiceBus.Sessions;

static class InteractiveBoundaryChecks
{
	static void Assert(bool value, string label)
	{
		if (!value)
			throw new Exception(label);
	}
	static async Task Rejected(Func<Task> run, OperationFailure expected)
	{
		try
		{
			await run();
		}
		catch (OperationException error) when (error.Failure == expected) { return; }
		throw new Exception($"Expected {expected}");
	}
	static ReceivedMessage Message(long sequence) => AzureReceivedMessage.Snapshot(ServiceBusModelFactory.ServiceBusReceivedMessage(
		body: BinaryData.FromString("{\"value\":1}"), messageId: "message-" + sequence, subject: "Visible label",
		sequenceNumber: sequence, lockedUntil: DateTimeOffset.UtcNow.AddMinutes(5), enqueuedTime: DateTimeOffset.UtcNow));
	public static async Task<int> Run()
	{
		var gateway = new Gateway();
		var target = new EntityTarget("queue", "orders");
		var inspection = new MessageInspectionService(gateway, _ => null);
		gateway.Peeks.Enqueue(() => Message(9007199254740993));
		var first = await inspection.PeekAsync(new(target, "active", "0", 1), default);
		var firstId = first.Items[0].SnapshotId!;
		Assert(first.NextSequenceNumber == "9007199254740994", "Peek cursors preserve exact Int64 precision");
		gateway.Peeks.Enqueue(() => throw new OperationCanceledException());
		try
		{
			await inspection.PeekAsync(new(target, "active", "0", 1), default);
		}
		catch (OperationCanceledException) { }
		Assert(inspection.Inspect(firstId).Summary.Subject == "Visible label", "Interrupted peeks retain the prior inspected page");
		Assert(inspection.Body(firstId, 0, 65536).TotalBytes == 11, "Body access stays bounded and byte exact");
		gateway.Peeks.Enqueue(() => Message(long.MaxValue));
		var last = await inspection.PeekAsync(new(target, "active", "0", 1), default);
		Assert(last.NextSequenceNumber is null, "Int64 maximum never wraps a cursor");
		await Rejected(() => Task.FromResult(inspection.Inspect(firstId)), OperationFailure.SnapshotExpired);

		var classifier = new AzureMessageMutationFailureClassifier();
		var receipts = new MutationReceipts(classifier);
		await using var interactive = new InteractiveReceiverService(gateway, new AzureMessageFailureClassifier(), (_, _, _, _) => null, (_, _, _, _) => null);
		var accepted = await interactive.AcceptSessionAsync(new(target, "session"), default);
		var lease = accepted.Session!.LeaseId;
		var same = await interactive.AcceptSessionAsync(new(target, "session"), default);
		Assert(same.Session!.LeaseId == lease && gateway.Opens == 1, "Accepting an already-owned active session does not reacquire it");
		var empty = await interactive.GetSessionStateAsync(lease, default);
		await interactive.ChangeSessionStateAsync(new(lease, "", null, empty.Revision!), () => { }, default);
		var zero = await interactive.GetSessionStateAsync(lease, default);
		Assert(!empty.IsSet && zero.IsSet && zero.Bytes == 0 && empty.Revision != zero.Revision, "Null and empty state have distinct revisions");

		Task<OperationOutcome> StateWrite(string id, string fingerprint) => receipts.ExecuteAsync(id, fingerprint, MutationScope.Messaging, async execution =>
		{
			await interactive.ChangeSessionStateAsync(new(lease, "YQ==", null, zero.Revision!), execution.Dispatch, default);
			return new("confirmed");
		}, (execution, failure, status) => interactive.ObserveMutationFailure(InteractiveMutation.SessionState, execution, failure, status), default);
		gateway.Receiver.WriteFailure = new IOException("SECRET lost state acknowledgement");
		var operationId = Guid.NewGuid().ToString();
		var uncertain = await StateWrite(operationId, "same-wire-request");
		Assert(uncertain.Status == "unknown" && !uncertain.Summary.Contains("SECRET") && interactive.CurrentDeliveries().Session!.StateUncertain, "Lost state acknowledgements retain uncertainty without leaking external messages");
		var writes = gateway.Receiver.StateWrites;
		Assert(await StateWrite(operationId, "same-wire-request") == uncertain && gateway.Receiver.StateWrites == writes, "Duplicate requests return the receipt without repeating a state write");
		await Rejected(() => StateWrite(operationId, "different-wire-request"), OperationFailure.InvalidInput);
		await Rejected(() => interactive.ChangeSessionStateAsync(new(lease, "YQ==", null, zero.Revision!), () => { }, default), OperationFailure.SessionLockUnavailable);
		await interactive.GetSessionStateAsync(lease, default);
		Assert(!interactive.CurrentDeliveries().Session!.StateUncertain, "An explicit broker read resolves state uncertainty");

		gateway.Receiver.Messages.Enqueue(Message(42));
		var held = await interactive.ReceiveAsync(new(target, "active", "session", 1, 1, null, lease), default);
		var delivery = held.Items.Single().DeliveryId;
		gateway.Receiver.SettlementFailure = new IOException("SECRET lost settlement acknowledgement");
		var settlementId = Guid.NewGuid().ToString();
		Task<OperationOutcome> Settle() => receipts.ExecuteAsync(settlementId, "settle-wire-request", MutationScope.Messaging,
			execution => interactive.SettleAsync(new(delivery, "complete", "", ""), execution, default),
			(execution, failure, status) => interactive.ObserveMutationFailure(InteractiveMutation.Other, execution, failure, status), default);
		var outcome = await Settle();
		Assert(outcome.Status == "unknown" && interactive.CurrentDeliveries().Items.Single().State == "unknown", "An interrupted settlement cannot be presented as a confirmed completion");
		await Settle();
		Assert(gateway.Receiver.Settlements == 1, "Receipt redelivery never repeats an uncertain settlement");
		await Rejected(() => interactive.ReceiveAsync(new(target, "active", "session", 1, 1, null, lease), default), OperationFailure.OperationBlocked);
		await interactive.ReleaseSessionAsync(lease);
		Assert(!interactive.HasReceiver && interactive.FindSnapshot(delivery) is null && gateway.Receiver.Disposed, "Release clears held snapshots and disposes the exclusive receiver");
		await Rejected(() => interactive.GetSessionStateAsync(lease, default), OperationFailure.SessionLeaseExpired);

		var calls = 0;
		using var cancelled = new CancellationTokenSource();
		cancelled.Cancel();
		var cancelledOutcome = await receipts.ExecuteAsync(Guid.NewGuid().ToString(), "cancelled", MutationScope.Messaging,
			_ => { calls++; return Task.FromResult(new MutationEffect("should not execute")); }, (_, _, _) => { }, cancelled.Token);
		Assert(cancelledOutcome.Status == "cancelled" && calls == 0, "Cancellation before dispatch is a retained receipt without a write");
		using var racing = new CancellationTokenSource();
		var acknowledged = await receipts.ExecuteAsync(Guid.NewGuid().ToString(), "acknowledged", MutationScope.Messaging,
			execution => { execution.Dispatch(); racing.Cancel(); return Task.FromResult(new MutationEffect("acknowledged")); }, (_, _, _) => { }, racing.Token);
		Assert(acknowledged.Status == "confirmed", "Broker acknowledgement wins a late cancellation race");
		var denied = classifier.Classify(new InvalidOperationException("SECRET wrapper", new Azure.RequestFailedException(403, "SECRET denied")), MutationScope.Authorization);
		Assert(denied.IsRejected && denied.SafeDescription!.StartsWith("SAS rule management was denied") && !denied.SafeDescription.Contains("SECRET"), "Infrastructure unwraps management rejections and emits the established safe wording");

		await using var catalog = new SessionCatalogService(gateway);
		var page = await catalog.ListAsync(target, null, default);
		Assert(page.Items.Count == 100 && page.ContinuationToken is not null && gateway.SessionIteratorsDisposed == 0, "Session enumeration retains its bounded live cursor");
		await catalog.CloseAsync("stale-cursor");
		Assert(gateway.SessionIteratorsDisposed == 0, "A stale close request cannot dispose a newer cursor");
		var tail = await catalog.ListAsync(target, page.ContinuationToken, default);
		Assert(tail.Items.Count == 1 && tail.ContinuationToken is null && gateway.SessionIteratorsDisposed == 1, "Exhausted session enumeration disposes its iterator");
		await Rejected(() => catalog.ListAsync(target, page.ContinuationToken, default), OperationFailure.SessionCursorInvalid);
		Console.WriteLine("Interactive boundary checks passed");
		return 0;
	}
	sealed class Gateway : IServiceBusMessagingGateway
	{
		public readonly Queue<Func<ReceivedMessage?>> Peeks = [];
		public readonly Receiver Receiver = new();
		public int Opens, SessionIteratorsDisposed;
		public Task<EntityDetails> GetEntityAsync(EntityTarget target, CancellationToken cancellation) => Task.FromResult(new EntityDetails(new(target, "Active", true), [], new(), null, MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow)));
		public Task<ReceivedMessage?> PeekOneAsync(EntityTarget target, string subQueue, long fromSequenceNumber, CancellationToken cancellation) => Task.FromResult(Peeks.Dequeue()());
		public Task<IMessageReceiver> OpenReceiverAsync(EntityTarget target, string subQueue, string sessionId, CancellationToken cancellation)
		{
			Opens++;
			return Task.FromResult<IMessageReceiver>(Receiver);
		}
		public async IAsyncEnumerable<string> ListSessionsAsync(EntityTarget target, [EnumeratorCancellation] CancellationToken cancellation)
		{
			try
			{
				for (var i = 0; i < 101; i++)
				{
					cancellation.ThrowIfCancellationRequested();
					await Task.Yield();
					yield return "session-" + i;
				}
			}
			finally { SessionIteratorsDisposed++; }
		}
		public Task<IReadOnlyList<long>> SendBatchAsync(EntityTarget target, IReadOnlyList<OutgoingMessage> messages, DateTimeOffset? scheduled, Action dispatching, CancellationToken cancellation) => throw new NotSupportedException();
		public Task CancelScheduledAsync(EntityTarget target, IReadOnlyList<long> sequences, Action dispatching, CancellationToken cancellation) => throw new NotSupportedException();
		public ITestMessageSender OpenTestSender(EntityTarget target) => throw new NotSupportedException();
		public Task SendAsync(EntityTarget target, OutgoingMessage message, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<IMessageReceiver> OpenReceiveDeleteReceiverAsync(EntityTarget target, string subQueue, string sessionId, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<IMessageReceiver> OpenNextSessionAsync(EntityTarget target, CancellationToken cancellation) => throw new NotSupportedException();
		public ValueTask DisposeAsync() => ValueTask.CompletedTask;
	}
	sealed class Receiver : IMessageReceiver
	{
		public readonly Queue<ReceivedMessage> Messages = [];
		public MessageBody? State;
		public Exception? WriteFailure, SettlementFailure;
		public int StateWrites, Settlements;
		public bool Disposed;
		public string? SessionId => "session";
		public DateTimeOffset? SessionLockedUntil => DateTimeOffset.UtcNow.AddMinutes(5);
		public Task RenewSessionLockAsync(CancellationToken cancellation) => Task.CompletedTask;
		public Task<MessageBody?> GetSessionStateAsync(CancellationToken cancellation) => Task.FromResult(State);
		public Task SetSessionStateAsync(MessageBody? state, CancellationToken cancellation)
		{
			StateWrites++;
			if (WriteFailure is not null)
				throw WriteFailure;
			State = state;
			return Task.CompletedTask;
		}
		public Task<IReadOnlyList<ReceivedMessage>> ReceiveAsync(int count, TimeSpan wait, CancellationToken cancellation) => Task.FromResult<IReadOnlyList<ReceivedMessage>>(Messages.Count == 0 ? [] : [Messages.Dequeue()]);
		public Task<ReceivedMessage> ReceiveDeferredAsync(long sequence, CancellationToken cancellation) => throw new NotSupportedException();
		public DateTimeOffset LockedUntil(ReceivedMessage message) => message.LockedUntil;
		public Task SettleAsync(ReceivedMessage message, string action, string reason, string description, CancellationToken cancellation)
		{
			Settlements++;
			if (SettlementFailure is not null)
				throw SettlementFailure;
			return Task.CompletedTask;
		}
		public Task ReplayAsync(ReceivedMessage original, EntityTarget destination, OutgoingMessage outgoing, CancellationToken cancellation) => throw new NotSupportedException();
		public ValueTask DisposeAsync()
		{
			Disposed = true;
			return ValueTask.CompletedTask;
		}
	}
}
