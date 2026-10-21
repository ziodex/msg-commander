using System.Transactions;
using Azure.Messaging.ServiceBus;
using Azure.Messaging.ServiceBus.Administration;
using MsgCommander.Host;

static class MutationAdapterChecks
{
	static void Assert(bool value, string label)
	{
		if (!value)
			throw new Exception(label);
	}
	public static async Task<int> Run()
	{
		var messaging = new Client();
		var dedicated = new List<Client>();
		await using var gateway = new AzureServiceBusGateway(new Admin(), messaging, () => { var client = new Client(); dedicated.Add(client); return client; });
		foreach (var kind in new[] { "queue", "topic" })
			await gateway.SendAsync(new(kind, "outgoing"), new OutgoingMessage(System.Text.Encoding.UTF8.GetBytes("hello")), default);
		Assert(messaging.Sends == 2 && messaging.SenderDisposed == 2, "Standalone sends use ordinary client and dispose senders");
		await using (var receiver = await gateway.OpenReceiverAsync(new("subscription", "audit", "events"), "dead-letter", "", default))
		{
			var client = dedicated[0];
			Assert(client.Path == "events/Subscriptions/audit" && client.SubQueue == SubQueue.DeadLetter && !client.Session, "Session-enabled subscription DLQ uses regular receiver");
			ReceivedMessage message;
			foreach (var action in new[] { "complete", "abandon", "dead-letter", "defer", "renew" })
			{
				message = (await receiver.ReceiveAsync(1, TimeSpan.FromSeconds(2), default))[0];
				await receiver.SettleAsync(message, action, "Reason", "Description", default);
			}
			Assert(client.Actions.Count(a => a == "receive") == 5 && client.Actions.Where(a => a != "receive").SequenceEqual(new[] { "complete", "abandon", "dead-letter:Reason:Description", "defer", "renew" }), "Explicit SDK settlement methods on owned deliveries");
			await receiver.ReceiveDeferredAsync(9007199254740993, default);
			Assert(client.Sequence == 9007199254740993, "Deferred sequence stays Int64");
			message = (await receiver.ReceiveAsync(1, TimeSpan.FromSeconds(2), default))[0];
			client.Actions.Clear();
			var outgoing = OutgoingMessages.Replay(message, "new", "replayed");
			Assert(outgoing.Body.ToMemory().Span.SequenceEqual(new byte[] { 0, 255, 65 }) && (long)outgoing.ApplicationProperties["exact"] == long.MaxValue, "Replay exact bytes and typed properties");
			Assert(!outgoing.ApplicationProperties.ContainsKey("DeadLetterReason") && outgoing.ScheduledEnqueueTime == default && outgoing.MessageId == "replayed" && outgoing.TimeToLive == TimeSpan.FromHours(1), "Replay ID, TTL and removed diagnostics/schedule");
			await receiver.ReplayAsync(message, new("topic", "target"), outgoing, default);
			Assert(client.Actions.SequenceEqual(new[] { "complete", "send" }) && client.Commits == 2 && client.Rollbacks == 0, "Send and complete enlisted in one committed transaction");
			try
			{
				await receiver.ReplayAsync(message, new("queue", "target"), outgoing, default);
				throw new Exception("Completed delivery was replayed");
			}
			catch (OperationException error) when (error.Failure == OperationFailure.DeliveryExpired) { }
			message = (await receiver.ReceiveAsync(1, TimeSpan.FromSeconds(2), default))[0];
			outgoing = OutgoingMessages.Replay(message, "new", "rejected-copy");
			client.ThrowOnSend = true;
			try
			{
				await receiver.ReplayAsync(message, new("queue", "target"), outgoing, default);
				throw new Exception("Expected send failure");
			}
			catch (UnauthorizedAccessException) { }
			Assert(client.Commits == 2 && client.Rollbacks == 1, "Rejected send rolls back completion without non-transactional fallback");
		}
		Assert(dedicated[0].Disposed && dedicated[0].ReceiverDisposed, "Dispose dedicated receiver and client");
		await using (var receiver = await gateway.OpenReceiverAsync(new("queue", "sessions"), "active", "session-001", default))
		{
			var client = dedicated[1];
			Assert(client.Session && client.SessionId == "session-001" && client.Path == "sessions", "Explicit queue session accepted on fresh client");
			var message = (await receiver.ReceiveAsync(1, TimeSpan.FromSeconds(2), default))[0];
			await receiver.SettleAsync(message, "renew", "", "", default);
			Assert(client.Actions.Single() == "renew-session" && receiver.LockedUntil(message) > DateTimeOffset.UtcNow.AddMinutes(4), "Session lock renewed and displayed");
		}
		await using (var receiver = await gateway.OpenReceiverAsync(new("subscription", "billing", "events"), "active", "session-002", default))
			Assert(dedicated[2].Path == "events/Subscriptions/billing" && dedicated[2].SessionId == "session-002", "Subscription session routing");
		try
		{
			await gateway.OpenReceiverAsync(new("queue", "sessions"), "dead-letter", "session-001", default);
			throw new Exception("Accepted DLQ filter");
		}
		catch (OperationException) { }
		try
		{
			await gateway.OpenReceiverAsync(new("subscription", "audit", "events"), "transfer-dead-letter", "session-001", default);
			throw new Exception("Accepted transfer DLQ session filter");
		}
		catch (OperationException) { }
		var binary = ServiceBusModelFactory.ServiceBusReceivedMessage(properties: new Dictionary<string, object> { ["binary"] = new byte[] { 0 } });
		try
		{
			OutgoingMessages.Replay(AzureReceivedMessage.Snapshot(binary), "new", "binary-replay");
			throw new Exception("Silently changed binary property");
		}
		catch (OperationException) { }
		Assert(dedicated.Count == 3 && messaging.Sends == 2, "No transaction client reuse or replay on ordinary client");
		Console.WriteLine("Mutation adapter checks passed");
		return 0;
	}
	static ServiceBusReceivedMessage Message() => ServiceBusModelFactory.ServiceBusReceivedMessage(body: new BinaryData(new byte[] { 0, 255, 65 }), messageId: "source", timeToLive: TimeSpan.FromHours(1), scheduledEnqueueTime: DateTimeOffset.UtcNow.AddHours(1), properties: new Dictionary<string, object> { ["exact"] = long.MaxValue, ["DeadLetterReason"] = "Bad" }, lockedUntil: DateTimeOffset.UtcNow.AddMinutes(1));
	sealed class Admin : ServiceBusAdministrationClient
	{
	}
	sealed class Client : ServiceBusClient
	{
		public string? Path, SessionId;
		public SubQueue SubQueue;
		public bool Session, Disposed, ReceiverDisposed, ThrowOnSend;
		public int Sends, SenderDisposed, Commits, Rollbacks;
		public long Sequence;
		public List<string> Actions { get; } = [];
		public override ServiceBusSender CreateSender(string queueOrTopicName) => new Sender(this);
		ServiceBusReceiver Create(string path, ServiceBusReceiverOptions options)
		{
			Assert(options.PrefetchCount == 0 && options.ReceiveMode == ServiceBusReceiveMode.PeekLock, "No prefetch or destructive receive");
			Path = path;
			SubQueue = options.SubQueue;
			return new Receiver(this);
		}
		public override ServiceBusReceiver CreateReceiver(string queueName, ServiceBusReceiverOptions options) => Create(queueName, options);
		public override ServiceBusReceiver CreateReceiver(string topicName, string subscriptionName, ServiceBusReceiverOptions options) => Create($"{topicName}/Subscriptions/{subscriptionName}", options);
		Task<ServiceBusSessionReceiver> Accept(string path, string sessionId, ServiceBusSessionReceiverOptions options)
		{
			Assert(options.PrefetchCount == 0 && options.ReceiveMode == ServiceBusReceiveMode.PeekLock, "Session PeekLock with no prefetch");
			Path = path;
			SessionId = sessionId;
			Session = true;
			return Task.FromResult<ServiceBusSessionReceiver>(new SessionReceiver(this));
		}
		public override Task<ServiceBusSessionReceiver> AcceptSessionAsync(string queueName, string sessionId, ServiceBusSessionReceiverOptions options, CancellationToken cancellationToken = default) => Accept(queueName, sessionId, options);
		public override Task<ServiceBusSessionReceiver> AcceptSessionAsync(string topicName, string subscriptionName, string sessionId, ServiceBusSessionReceiverOptions options, CancellationToken cancellationToken = default) => Accept($"{topicName}/Subscriptions/{subscriptionName}", sessionId, options);
		public void Enlist()
		{
			if (Transaction.Current is { } transaction)
				transaction.EnlistVolatile(new Vote(this), EnlistmentOptions.None);
		}
		public override ValueTask DisposeAsync()
		{
			Disposed = true;
			return ValueTask.CompletedTask;
		}
	}
	sealed class Vote(Client client) : IEnlistmentNotification
	{
		public void Prepare(PreparingEnlistment enlistment) => enlistment.Prepared();
		public void Commit(Enlistment enlistment)
		{
			client.Commits++;
			enlistment.Done();
		}
		public void Rollback(Enlistment enlistment)
		{
			client.Rollbacks++;
			enlistment.Done();
		}
		public void InDoubt(Enlistment enlistment) => enlistment.Done();
	}
	sealed class Sender(Client client) : ServiceBusSender
	{
		public override Task SendMessageAsync(ServiceBusMessage message, CancellationToken cancellationToken = default)
		{
			client.Actions.Add("send");
			if (client.ThrowOnSend)
				throw new UnauthorizedAccessException();
			client.Enlist();
			client.Sends++;
			return Task.CompletedTask;
		}
		public override ValueTask DisposeAsync()
		{
			client.SenderDisposed++;
			return ValueTask.CompletedTask;
		}
	}
	sealed class Receiver(Client client) : ServiceBusReceiver
	{
		public override Task<IReadOnlyList<ServiceBusReceivedMessage>> ReceiveMessagesAsync(int maxMessages, TimeSpan? maxWaitTime = null, CancellationToken cancellationToken = default)
		{
			client.Actions.Add("receive");
			return Task.FromResult<IReadOnlyList<ServiceBusReceivedMessage>>([Message()]);
		}
		public override Task<ServiceBusReceivedMessage> ReceiveDeferredMessageAsync(long sequenceNumber, CancellationToken cancellationToken = default)
		{
			client.Sequence = sequenceNumber;
			return Task.FromResult(Message());
		}
		public override Task CompleteMessageAsync(ServiceBusReceivedMessage message, CancellationToken cancellationToken = default)
		{
			client.Actions.Add("complete");
			client.Enlist();
			return Task.CompletedTask;
		}
		public override Task AbandonMessageAsync(ServiceBusReceivedMessage message, IDictionary<string, object>? propertiesToModify = null, CancellationToken cancellationToken = default)
		{
			client.Actions.Add("abandon");
			return Task.CompletedTask;
		}
		public override Task DeadLetterMessageAsync(ServiceBusReceivedMessage message, string deadLetterReason, string? deadLetterErrorDescription = null, CancellationToken cancellationToken = default)
		{
			client.Actions.Add($"dead-letter:{deadLetterReason}:{deadLetterErrorDescription}");
			return Task.CompletedTask;
		}
		public override Task DeferMessageAsync(ServiceBusReceivedMessage message, IDictionary<string, object>? propertiesToModify = null, CancellationToken cancellationToken = default)
		{
			client.Actions.Add("defer");
			return Task.CompletedTask;
		}
		public override Task RenewMessageLockAsync(ServiceBusReceivedMessage message, CancellationToken cancellationToken = default)
		{
			client.Actions.Add("renew");
			return Task.CompletedTask;
		}
		public override ValueTask DisposeAsync()
		{
			client.ReceiverDisposed = true;
			return ValueTask.CompletedTask;
		}
	}
	sealed class SessionReceiver(Client client) : ServiceBusSessionReceiver
	{
		public override Task<IReadOnlyList<ServiceBusReceivedMessage>> ReceiveMessagesAsync(int maxMessages, TimeSpan? maxWaitTime = null, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<ServiceBusReceivedMessage>>([Message()]);
		public override DateTimeOffset SessionLockedUntil => DateTimeOffset.UtcNow.AddMinutes(5);
		public override Task RenewSessionLockAsync(CancellationToken cancellationToken = default)
		{
			client.Actions.Add("renew-session");
			return Task.CompletedTask;
		}
		public override ValueTask DisposeAsync()
		{
			client.ReceiverDisposed = true;
			return ValueTask.CompletedTask;
		}
	}
}
