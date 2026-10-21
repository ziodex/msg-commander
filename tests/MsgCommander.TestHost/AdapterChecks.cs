using Azure.Messaging.ServiceBus;
using Azure.Messaging.ServiceBus.Administration;
using MsgCommander.Host;

static class AdapterChecks
{
	public static async Task<int> Run()
	{
		var client = new SpyClient();
		await using (var gateway = new AzureServiceBusGateway(new SpyAdmin(), client))
		{
			await gateway.PeekOneAsync(new("queue", "session-queue"), "active", 9007199254740993, default);
			Assert(client.Receivers.Count == 1 && client.Receivers[0].SubQueue == SubQueue.None && client.Receivers[0].Receiver.Sequence == 9007199254740993, "Queue cursor/options");
			await gateway.PeekOneAsync(new("queue", "session-queue"), "active", 9007199254740994, default);
			Assert(client.Receivers.Count == 1, "Reuse receiver for same entity");
			await gateway.PeekOneAsync(new("subscription", "billing", "events"), "dead-letter", 42, default);
			Assert(client.Receivers.Count == 2 && client.Receivers[0].Receiver.Disposed, "Dispose prior receiver");
			Assert(client.Receivers[1].Path == "events/Subscriptions/billing" && client.Receivers[1].SubQueue == SubQueue.DeadLetter && client.Receivers[1].Receiver.Sequence == 42, "Subscription dead-letter routing");
			try
			{
				await gateway.PeekOneAsync(new("topic", "events"), "dead-letter", 0, default);
				throw new Exception("Accepted topic dead-letter view");
			}
			catch (OperationException) { }
			foreach (var target in new EntityTarget[] { new("queue", "forwarding"), new("subscription", "audit", "events") })
			{
				await gateway.PeekOneAsync(target, "dead-letter", 0, default);
				var previous = client.Receivers[^1].Receiver;
				await gateway.PeekOneAsync(target, "transfer-dead-letter", 9007199254740995, default);
				var captured = client.Receivers[^1];
				Assert(previous.Disposed && captured.SubQueue == SubQueue.TransferDeadLetter && captured.Receiver.Sequence == 9007199254740995,
					"Changing only the subqueue disposes the DLQ receiver and targets transfer DLQ with exact cursor");
				Assert(captured.Path == (target.Kind == "queue" ? "forwarding" : "events/Subscriptions/audit"), "Transfer DLQ stays on the forwarding source");
			}
			var before = client.Receivers.Count;
			foreach (var selector in new[] { "transfer", "", "DEAD-LETTER" })
			{
				try
				{
					await gateway.PeekOneAsync(new("queue", "jobs"), selector, 0, default);
					throw new Exception("Accepted invalid selector");
				}
				catch (OperationException) { }
			}
			try
			{
				await gateway.PeekOneAsync(new("topic", "events"), "transfer-dead-letter", 0, default);
				throw new Exception("Accepted topic transfer DLQ");
			}
			catch (OperationException) { }
			Assert(client.Receivers.Count == before, "Invalid selectors never open a receiver");
		}
		Assert(client.Disposed && client.Receivers.All(r => r.Receiver.Disposed), "Dispose connection");
		var factory = new AzureServiceBusGatewayFactory();
		try
		{
			await factory.ConnectAsync(new(Guid.NewGuid().ToString(), "bad", "service-bus", "fixture.servicebus.windows.net", "sas", "", "", "Endpoint=sb://different.servicebus.windows.net/;SharedAccessKeyName=Test;SharedAccessKey=ZmFrZQ=="), _ => Task.CompletedTask, default);
			throw new Exception("Accepted mismatched namespace");
		}
		catch (OperationException) { }
		Console.WriteLine("Adapter checks passed");
		return 0;
	}
	static void Assert(bool value, string label)
	{
		if (!value)
			throw new Exception(label);
	}
	sealed class SpyAdmin : ServiceBusAdministrationClient
	{
	}
	sealed class SpyClient : ServiceBusClient
	{
		public List<(string Path, SubQueue SubQueue, SpyReceiver Receiver)> Receivers { get; } = [];
		public bool Disposed
		{
			get; private set;
		}
		public override ServiceBusReceiver CreateReceiver(string queueName, ServiceBusReceiverOptions options) => Create(queueName, options);
		public override ServiceBusReceiver CreateReceiver(string topicName, string subscriptionName, ServiceBusReceiverOptions options) => Create($"{topicName}/Subscriptions/{subscriptionName}", options);
		private SpyReceiver Create(string path, ServiceBusReceiverOptions options)
		{
			Assert(options.PrefetchCount == 0, "No prefetch");
			var receiver = new SpyReceiver();
			Receivers.Add((path, options.SubQueue, receiver));
			return receiver;
		}
		public override ValueTask DisposeAsync()
		{
			Disposed = true;
			return ValueTask.CompletedTask;
		}
	}
	sealed class SpyReceiver : ServiceBusReceiver
	{
		public long? Sequence
		{
			get; private set;
		}
		public bool Disposed
		{
			get; private set;
		}
		public override Task<IReadOnlyList<ServiceBusReceivedMessage>> PeekMessagesAsync(int maxMessages, long? fromSequenceNumber = null, CancellationToken cancellationToken = default)
		{
			Assert(maxMessages == 1 && fromSequenceNumber is not null, "Bounded peek with explicit cursor");
			Sequence = fromSequenceNumber;
			return Task.FromResult<IReadOnlyList<ServiceBusReceivedMessage>>([]);
		}
		public override ValueTask DisposeAsync()
		{
			Disposed = true;
			return ValueTask.CompletedTask;
		}
	}
}
