using System.Runtime.Serialization;
using System.Text.Json;
using System.Transactions;
using Azure;
using Azure.Messaging.ServiceBus;
using MsgCommander.Application.ServiceBus.Maintenance;
using MsgCommander.Domain.ServiceBus.Messages;

static class MaintenanceBoundaryChecks
{
	static readonly EntityTarget Source = new("queue", "source"), Destination = new("queue", "destination");
	static string Id() => Guid.NewGuid().ToString();
	static void Assert(bool value, string label)
	{
		if (!value)
			throw new Exception(label);
	}
	static async Task Reject(Func<Task> run, OperationFailure expected)
	{
		try
		{
			await run();
		}
		catch (OperationException error) when (error.Failure == expected) { return; }
		throw new Exception("Expected " + expected);
	}
	static ReceivedMessage Message(long sequence, DateTimeOffset? enqueued = null) => AzureReceivedMessage.Snapshot(ServiceBusModelFactory.ServiceBusReceivedMessage(
		body: BinaryData.FromString("body"), messageId: "message-" + sequence, subject: "message label", sequenceNumber: sequence,
		enqueuedTime: enqueued ?? DateTimeOffset.UtcNow, lockedUntil: DateTimeOffset.UtcNow.AddMinutes(5)));
	public static async Task<int> Run()
	{
		var cutoff = PurgeCutoff.Parse("2026-10-01T10:00:00.000Z");
		Assert(PurgeCutoff.Includes(cutoff, cutoff.AddTicks(-1)) && !PurgeCutoff.Includes(cutoff, cutoff), "Purge eligibility excludes the cutoff instant itself");
		foreach (var invalid in new[] { "2026-10-01T10:00:00Z", "2026-10-01T10:00:00.000+00:00", "2026-02-30T10:00:00.000Z" })
		{
			try
			{
				PurgeCutoff.Parse(invalid);
				throw new Exception("Accepted invalid cutoff");
			}
			catch (MsgCommander.Domain.Common.DomainRuleException) { }
		}
		var classifier = new AzureMaintenanceFailureClassifier();
		Assert(!classifier.Classify(new RequestFailedException(409, "SECRET"), MaintenanceOperation.Purge).IsRejected &&
			classifier.Classify(new RequestFailedException(409, "SECRET"), MaintenanceOperation.Resend).IsRejected, "Purge and recovery retain different HTTP rejection sets");
		var lost = new ServiceBusException("SECRET", ServiceBusFailureReason.MessageLockLost);
		Assert(classifier.Classify(lost, MaintenanceOperation.Purge).IsRejected && !classifier.Classify(lost, MaintenanceOperation.ReceiveDelete).IsRejected, "Receive-and-delete does not misclassify an interrupted transfer as a rejected settlement");
		Assert(classifier.Classify(new TransactionAbortedException(), MaintenanceOperation.Resend).IsRejected &&
			!classifier.Classify(new TransactionAbortedException(), MaintenanceOperation.CrossNamespaceResend).IsRejected, "Atomic rollback and independent writes have distinct failure semantics");
		Assert(classifier.Classify(new SerializationException("SECRET"), MaintenanceOperation.Resend).IsRejected, "Known encoding rejection remains definitive");

		var ledger = new OperationReceipts<string>(1, "conflict", "capacity");
		var recordedId = Id();
		ledger.Add(recordedId, "request", "result");
		Assert(ledger.CheckRequest(recordedId, "request") == "result", "A duplicate can be recovered even at receipt capacity");
		await Reject(() => Task.FromResult(ledger.CheckRequest(recordedId, "changed")), OperationFailure.InvalidInput);
		await Reject(() => Task.FromResult(ledger.CheckRequest(Id(), "new")), OperationFailure.OperationBlocked);

		var source = new Gateway();
		var invalidations = 0;
		var receiver = new Receiver();
		receiver.Messages.Enqueue(Message(9007199254740993, cutoff.AddDays(-1)));
		source.Receivers.Enqueue(receiver);
		var purge = new PurgeService(source, "source.test", () => false, () => invalidations++, classifier);
		var purgeRequest = new PurgeMessages(Id(), Source, "active", 1, 30, "PURGE source.test/source/active BEFORE 2026-10-01T10:00:00.000Z", new(true, "2026-10-01T10:00:00.000Z"));
		var confirmed = await purge.ExecuteAsync(purgeRequest, "purge", progress => progress.Phase == "receiving" && progress.Completed == 1 ? Task.FromException(new IOException("SECRET progress lost")) : Task.CompletedTask, default);
		Assert(confirmed.Completed == 1 && confirmed.Uncertain == 0 && confirmed.Status == "failed" && receiver.Disposed && invalidations == 1, "Progress failure cannot erase an acknowledged purge completion");
		Assert(await purge.ExecuteAsync(purgeRequest, "purge", _ => Task.CompletedTask, default) == confirmed && receiver.Settlements == 1, "A repeated purge returns its receipt without another completion");
		var uncertainReceiver = new Receiver { SettlementFailure = new IOException("SECRET completion acknowledgement lost") };
		uncertainReceiver.Messages.Enqueue(Message(2));
		source.Receivers.Enqueue(uncertainReceiver);
		var unknown = await purge.ExecuteAsync(purgeRequest with
		{
			Id = Id(),
			Confirmation = "PURGE source.test/source/active",
			Cutoff = new(false, null)
		}, "uncertain", _ => Task.CompletedTask, default);
		Assert(unknown.Uncertain == 1 && unknown.Completed == 0 && unknown.Status == "unknown" && uncertainReceiver.Disposed && !unknown.Summary.Contains("SECRET"), "An interrupted purge records uncertainty and closes its receiver");

		var bulk = new BulkPurgeService(source, purge, "source.test", () => false);
		var plan = await bulk.PreviewAsync(new([new(Source, "active"), new(Destination, "active")], 10, 1, 30, new(false, null)), default);
		Assert(((IList<BulkPurgePreviewItem>)plan.Items).IsReadOnly, "A reviewed target list cannot be modified by the caller");
		await Reject(() => bulk.ExecuteAsync(new(Id(), plan.PlanId, plan.Confirmation, true), "override", _ => Task.CompletedTask, default), OperationFailure.InvalidInput);
		var bulkReceiver = new Receiver();
		bulkReceiver.Messages.Enqueue(Message(3));
		source.Receivers.Enqueue(bulkReceiver);
		List<BulkPurgeProgress> progressRows = [];
		var bulkResult = await bulk.ExecuteAsync(new(Id(), plan.PlanId, plan.Confirmation, false), "bulk", progress => { progressRows.Add(progress); return Task.CompletedTask; }, default);
		Assert(bulkResult.Completed == 1 && bulkResult.Reason == "total-limit" && bulkResult.Items[1].Result is null, "Bulk deletion uses one reviewed global budget");
		Assert(progressRows.First().Items[0].Result is null && bulkResult.Items[0].Result is not null, "Stored progress snapshots do not mutate when later targets finish");
		await Reject(() => bulk.ExecuteAsync(new(Id(), plan.PlanId, plan.Confirmation, false), "used-review", _ => Task.CompletedTask, default), OperationFailure.InvalidInput);

		using var racing = new CancellationTokenSource();
		var consumedReceiver = new Receiver { AfterReceive = () => racing.Cancel() };
		consumedReceiver.Messages.Enqueue(Message(4));
		source.Receivers.Enqueue(consumedReceiver);
		var consumed = new ReceiveDeleteService(source, "source.test", () => false, classifier);
		var consumedRequest = new ReceiveDeleteMessages(Id(), Source, "active", "", 1, 30, "RECEIVE AND DELETE source.test/source/active");
		var consumedResult = await consumed.ExecuteAsync(consumedRequest, "consumed", _ => Task.CompletedTask, racing.Token);
		var snapshotId = consumedResult.Items.Single().SnapshotId!;
		Assert(consumedResult.Received == 1 && !consumedResult.Uncertain && consumed.FindSnapshot(snapshotId)!.Value.Body.Span.SequenceEqual("body"u8), "A returned destructive transfer is retained across a concurrent cancellation");
		Assert(consumedReceiver.Settlements == 0 && consumedReceiver.Disposed && ((IList<MessageSummary>)consumedResult.Items).IsReadOnly, "Consumed messages never expose settlement and retained result items are read-only");
		Assert(await consumed.ExecuteAsync(consumedRequest, "consumed", _ => Task.CompletedTask, default) == consumedResult && consumedReceiver.Receives == 1, "Destructive receipt redelivery never receives again");
		var interrupted = new Receiver { ReceiveFailure = new IOException("SECRET lost transfer") };
		source.Receivers.Enqueue(interrupted);
		var unknownConsumed = await consumed.ExecuteAsync(consumedRequest with
		{
			Id = Id()
		}, "lost-consumed", _ => Task.CompletedTask, default);
		Assert(unknownConsumed.Status == "unknown" && unknownConsumed.Uncertain && unknownConsumed.Received == 0 && interrupted.Disposed && !unknownConsumed.Summary.Contains("SECRET"), "An unreported destructive transfer has an unknown total");

		async Task<ResendResult> Cross(bool cancelAfterSend)
		{
			var broker = new Gateway();
			var sourceReceiver = new Receiver();
			sourceReceiver.Messages.Enqueue(Message(long.MaxValue));
			broker.Receivers.Enqueue(sourceReceiver);
			var destination = new Gateway();
			using var cancellation = new CancellationTokenSource();
			if (cancelAfterSend)
				destination.AfterSend = () => cancellation.Cancel();
			else
				sourceReceiver.SettlementFailure = new IOException("SECRET completion response lost");
			var recovery = new DeadLetterRecoveryService(broker, (_, _, _) => Task.FromResult<IServiceBusMessagingGateway>(destination), "source.test", () => false, () => { }, classifier);
			var profileId = Id();
			var request = new ResendDeadLetters(Id(), Source, "dead-letter", Destination, "remove", "new", 1, 30,
				new(profileId, "destination.test", new(profileId, "destination", "service-bus", "destination.test", "sas", "", "", "SECRET credential"), true));
			var result = await recovery.ExecuteAsync(request, "public-request", _ => Task.CompletedTask, _ => Task.CompletedTask, cancellation.Token);
			Assert(result.Sent == 1 && result.Removed == 0 && result.CopiedNotRemoved == 1 && result.Transfers.Single().Send == "confirmed", "Source completion follows an acknowledged destination send");
			Assert(result.Transfers.Single().SourceSequenceNumber == long.MaxValue.ToString() && !JsonSerializer.Serialize(result).Contains("SECRET"), "Recovery retains exact reconciliation IDs and excludes credentials and external error text");
			Assert(sourceReceiver.Disposed && destination.Disposed && ((IList<ResendTransfer>)result.Transfers).IsReadOnly, "Independent recovery endpoints are disposed and ledger rows cannot be modified");
			Assert(await recovery.ExecuteAsync(request with
			{
				CrossNamespace = null
			}, "public-request", _ => Task.CompletedTask, _ => Task.CompletedTask, default) == result && destination.Sends == 1,
				"A repeated public request returns its receipt before destination credentials are needed");
			if (cancelAfterSend)
				Assert(result.Status == "cancelled" && result.Uncertain == 0 && result.Transfers[0].Source == "not-removed" && sourceReceiver.Settlements == 0, "Cancellation after send acknowledgement keeps the source untouched");
			else
				Assert(result.Status == "unknown" && result.Uncertain == 1 && result.Transfers[0].Source == "unknown" && sourceReceiver.Settlements == 1, "Lost source completion acknowledges the copy and marks only source removal uncertain");
			return result;
		}
		await Cross(true);
		await Cross(false);
		Console.WriteLine("Maintenance boundary checks passed");
		return 0;
	}
	sealed class Gateway : IServiceBusMessagingGateway
	{
		public readonly Queue<Receiver> Receivers = [];
		public Action? AfterSend;
		public bool Disposed;
		public int Sends;
		public Task<EntityDetails> GetEntityAsync(EntityTarget target, CancellationToken cancellation) => Task.FromResult(new EntityDetails(new(target, "Active", false), [], new(Active: "1"), null, MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow)));
		public Task<ReceivedMessage?> PeekOneAsync(EntityTarget target, string subQueue, long fromSequenceNumber, CancellationToken cancellation) => Task.FromResult<ReceivedMessage?>(null);
		public Task<IMessageReceiver> OpenReceiverAsync(EntityTarget target, string subQueue, string sessionId, CancellationToken cancellation) => Task.FromResult<IMessageReceiver>(Receivers.Dequeue());
		public Task<IMessageReceiver> OpenReceiveDeleteReceiverAsync(EntityTarget target, string subQueue, string sessionId, CancellationToken cancellation) => OpenReceiverAsync(target, subQueue, sessionId, cancellation);
		public Task SendAsync(EntityTarget target, OutgoingMessage message, CancellationToken cancellation)
		{
			Sends++;
			AfterSend?.Invoke();
			return Task.CompletedTask;
		}
		public IAsyncEnumerable<string> ListSessionsAsync(EntityTarget target, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<IReadOnlyList<long>> SendBatchAsync(EntityTarget target, IReadOnlyList<OutgoingMessage> messages, DateTimeOffset? scheduled, Action dispatching, CancellationToken cancellation) => throw new NotSupportedException();
		public Task CancelScheduledAsync(EntityTarget target, IReadOnlyList<long> sequences, Action dispatching, CancellationToken cancellation) => throw new NotSupportedException();
		public ITestMessageSender OpenTestSender(EntityTarget target) => throw new NotSupportedException();
		public Task<IMessageReceiver> OpenNextSessionAsync(EntityTarget target, CancellationToken cancellation) => throw new NotSupportedException();
		public ValueTask DisposeAsync()
		{
			Disposed = true;
			return ValueTask.CompletedTask;
		}
	}
	sealed class Receiver : IMessageReceiver
	{
		public readonly Queue<ReceivedMessage> Messages = [];
		public Exception? ReceiveFailure, SettlementFailure;
		public Action? AfterReceive;
		public int Receives, Settlements;
		public bool Disposed;
		public string? SessionId => null;
		public DateTimeOffset? SessionLockedUntil => null;
		public Task RenewSessionLockAsync(CancellationToken cancellation) => Task.CompletedTask;
		public Task<MessageBody?> GetSessionStateAsync(CancellationToken cancellation) => throw new NotSupportedException();
		public Task SetSessionStateAsync(MessageBody? state, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<IReadOnlyList<ReceivedMessage>> ReceiveAsync(int count, TimeSpan wait, CancellationToken cancellation)
		{
			Receives++;
			if (ReceiveFailure is not null)
				throw ReceiveFailure;
			IReadOnlyList<ReceivedMessage> result = Messages.Count == 0 ? [] : [Messages.Dequeue()];
			AfterReceive?.Invoke();
			return Task.FromResult(result);
		}
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
