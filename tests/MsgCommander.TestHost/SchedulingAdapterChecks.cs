using Azure.Messaging.ServiceBus;
using Azure.Messaging.ServiceBus.Administration;
using MsgCommander.Host;

static class SchedulingAdapterChecks
{
	static void Assert(bool value, string label)
	{
		if (!value)
			throw new Exception(label);
	}
	public static async Task<int> Run()
	{
		var client = new Client();
		await using var gateway = new AzureServiceBusGateway(new Admin(), client);
		var target = new EntityTarget("topic", "events");
		var messages = new[] { new OutgoingMessage(new byte[] { 0, 255 }) { MessageId = "one" }, new OutgoingMessage(System.Text.Encoding.UTF8.GetBytes("two")) { MessageId = "two" } };
		var dispatches = 0;
		await gateway.SendBatchAsync(target, messages, null, () => dispatches++, default);
		Assert(dispatches == 1 && client.BatchSends == 1 && client.SingleSends == 0 && client.Path == "events" && client.Added == 2, "One atomic SDK batch, not a loop of individual sends");
		client.RejectAt = 2;
		try
		{
			await gateway.SendBatchAsync(target, messages, null, () => dispatches++, default);
			throw new Exception("Expected oversized batch rejection");
		}
		catch (OperationException) { }
		Assert(dispatches == 1 && client.BatchSends == 1 && client.Disposals == 2, "Oversized second message never dispatches first message and sender is disposed");
		client.RejectAt = 0;
		var future = DateTimeOffset.UtcNow.AddHours(2);
		var sequences = await gateway.SendBatchAsync(target, messages, future, () => dispatches++, default);
		Assert(sequences.SequenceEqual(new long[] { 9007199254740993, long.MaxValue }) && client.ScheduledTime == future && client.Scheduled!.Select(m => m.MessageId).SequenceEqual(messages.Select(m => m.MessageId)), "Scheduling returns exact Int64 sequences in one SDK call");
		Assert(client.Scheduled![0].Body.ToMemory().Span.SequenceEqual(new byte[] { 0, 255 }), "Binary body retained");
		await gateway.CancelScheduledAsync(target, sequences, () => dispatches++, default);
		Assert(client.Cancelled!.SequenceEqual(sequences) && client.Path == "events", "Cancellation routed to topic sender with exact sequence numbers");
		await gateway.PeekOneAsync(target, "active", 9007199254740993, default);
		Assert(client.Path == "events" && client.PeekFrom == 9007199254740993 && !client.SubscriptionReceiver, "Topic schedules peek directly on topic, no subscription");
		await gateway.PeekOneAsync(new("subscription", "audit", "events"), "active", 0, default);
		Assert(client.SubscriptionReceiver && client.Path == "events/Subscriptions/audit", "Ordinary subscription peek routing preserved");
		using var cancelled = new CancellationTokenSource();
		cancelled.Cancel();
		var previous = dispatches;
		try
		{
			await gateway.CancelScheduledAsync(target, sequences, () => dispatches++, cancelled.Token);
			throw new Exception("Expected cancelled request");
		}
		catch (OperationCanceledException) { }
		Assert(dispatches == previous, "Pre-dispatch cancellation does not call SDK write");
		Console.WriteLine("Scheduling adapter checks passed");
		return 0;
	}
	sealed class Admin : ServiceBusAdministrationClient
	{
	}
	sealed class Client : ServiceBusClient
	{
		public int BatchSends, SingleSends, Disposals, RejectAt, Added;
		public string? Path;
		public bool SubscriptionReceiver;
		public DateTimeOffset ScheduledTime;
		public ServiceBusMessage[]? Scheduled;
		public long[]? Cancelled;
		public long PeekFrom;
		public override ValueTask DisposeAsync() => ValueTask.CompletedTask;
		public override ServiceBusSender CreateSender(string queueOrTopicName)
		{
			Path = queueOrTopicName;
			return new Sender(this);
		}
		public override ServiceBusReceiver CreateReceiver(string queueName, ServiceBusReceiverOptions options)
		{
			Path = queueName;
			SubscriptionReceiver = false;
			return new Receiver(this);
		}
		public override ServiceBusReceiver CreateReceiver(string topicName, string subscriptionName, ServiceBusReceiverOptions options)
		{
			Path = $"{topicName}/Subscriptions/{subscriptionName}";
			SubscriptionReceiver = true;
			return new Receiver(this);
		}
	}
	sealed class Sender(Client client) : ServiceBusSender
	{
		public override ValueTask<ServiceBusMessageBatch> CreateMessageBatchAsync(CancellationToken cancellationToken = default)
		{
			client.Added = 0;
			return ValueTask.FromResult(ServiceBusModelFactory.ServiceBusMessageBatch(100, new List<ServiceBusMessage>(), tryAddCallback: message => ++client.Added != client.RejectAt));
		}
		public override Task SendMessagesAsync(ServiceBusMessageBatch batch, CancellationToken cancellationToken = default)
		{
			client.BatchSends++;
			Assert(batch.Count == 2, "Complete batch present at dispatch");
			return Task.CompletedTask;
		}
		public override Task SendMessageAsync(ServiceBusMessage message, CancellationToken cancellationToken = default)
		{
			client.SingleSends++;
			return Task.CompletedTask;
		}
		public override Task<IReadOnlyList<long>> ScheduleMessagesAsync(IEnumerable<ServiceBusMessage> messages, DateTimeOffset scheduledEnqueueTime, CancellationToken cancellationToken = default)
		{
			client.Scheduled = messages.ToArray();
			client.ScheduledTime = scheduledEnqueueTime;
			return Task.FromResult<IReadOnlyList<long>>([9007199254740993, long.MaxValue]);
		}
		public override Task CancelScheduledMessagesAsync(IEnumerable<long> sequenceNumbers, CancellationToken cancellationToken = default)
		{
			client.Cancelled = sequenceNumbers.ToArray();
			return Task.CompletedTask;
		}
		public override ValueTask DisposeAsync()
		{
			client.Disposals++;
			return ValueTask.CompletedTask;
		}
	}
	sealed class Receiver(Client client) : ServiceBusReceiver
	{
		public override ValueTask DisposeAsync() => ValueTask.CompletedTask;
		public override Task<IReadOnlyList<ServiceBusReceivedMessage>> PeekMessagesAsync(int maxMessages, long? fromSequenceNumber = null, CancellationToken cancellationToken = default)
		{
			client.PeekFrom = fromSequenceNumber!.Value;
			return Task.FromResult<IReadOnlyList<ServiceBusReceivedMessage>>([]);
		}
	}
}
