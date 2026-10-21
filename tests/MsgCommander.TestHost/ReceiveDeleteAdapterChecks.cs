using Azure.Messaging.ServiceBus;
using Azure.Messaging.ServiceBus.Administration;
using MsgCommander.Host;

static class ReceiveDeleteAdapterChecks
{
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	public static async Task<int> Run()
	{
		List<Client> clients = [];
		await using var gateway = new AzureServiceBusGateway(new Admin(), new Client(), () => { var c = new Client(); clients.Add(c); return c; });
		foreach (var target in new EntityTarget[] { new("queue", "jobs"), new("subscription", "worker", "jobs") })
		{
			var path = target.Kind == "queue" ? "jobs" : "jobs/Subscriptions/worker";
			foreach (var (selector, expected) in new[] { ("active", SubQueue.None), ("dead-letter", SubQueue.DeadLetter), ("transfer-dead-letter", SubQueue.TransferDeadLetter) })
			{
				using var cancel = new CancellationTokenSource();
				await using (var receiver = await gateway.OpenReceiveDeleteReceiverAsync(target, selector, "", cancel.Token))
				{
					var spy = clients[^1];
					Assert(spy.Path == path && spy.SubQueue == expected, "Correct queue/subscription subqueue");
					var message = (await receiver.ReceiveAsync(1, TimeSpan.FromSeconds(2), cancel.Token)).Single();
					Assert(message is not null, "Received a message");
					Assert(spy.Received == 1 && spy.Completed == 0 && spy.Token == cancel.Token, "No settlement; cancellation forwarded");
				}
				Assert(clients[^1].Disposed && clients[^1].ReceiverDisposed, "Regular purge receiver/client released");
			}
			await using (var receiver = await gateway.OpenReceiveDeleteReceiverAsync(target, "active", "selected", default))
			{
				Assert(clients[^1].Path == path && clients[^1].NextSession && receiver.SessionId == "selected", "Accept selected session routing");
				await receiver.RenewSessionLockAsync(default);
				Assert(clients[^1].Renewed, "Owned purge session can be renewed");
			}
			Assert(clients[^1].Disposed && clients[^1].ReceiverDisposed, "Next-session receiver/client released");
		}
		try
		{
			await gateway.OpenReceiveDeleteReceiverAsync(new("topic", "jobs"), "active", "", default);
			throw new Exception("Topic accepted");
		}
		catch (OperationException) { }
		foreach (var subQueue in new[] { "dead-letter", "transfer-dead-letter" })
			try
			{
				await gateway.OpenReceiveDeleteReceiverAsync(new("queue", "jobs"), subQueue, "selected", default);
				throw new Exception("DLQ session accepted");
			}
			catch (OperationException) { }
		await using var failing = new AzureServiceBusGateway(new Admin(), new Client(), () => { var c = new Client { Fail = true }; clients.Add(c); return c; });
		try
		{
			await failing.OpenReceiveDeleteReceiverAsync(new("queue", "jobs"), "active", "selected", default);
			throw new Exception("Failure ignored");
		}
		catch (ServiceBusException) { }
		Assert(clients[^1].Disposed, "Failed acceptance disposes the client");
		Console.WriteLine("Receive-and-delete adapter checks passed");
		return 0;
	}
	sealed class Admin : ServiceBusAdministrationClient
	{
	}
	sealed class Client : ServiceBusClient
	{
		public string? Path;
		public SubQueue SubQueue;
		public bool NextSession, Disposed, ReceiverDisposed, Renewed, Fail;
		public int Received, Completed;
		public CancellationToken Token;
		ServiceBusReceiver Create(string path, ServiceBusReceiverOptions options)
		{
			Assert(options.ReceiveMode == ServiceBusReceiveMode.ReceiveAndDelete && options.PrefetchCount == 0, "Explicit ReceiveAndDelete without prefetch");
			Path = path;
			SubQueue = options.SubQueue;
			return new Receiver(this);
		}
		public override ServiceBusReceiver CreateReceiver(string queueName, ServiceBusReceiverOptions options) => Create(queueName, options);
		public override ServiceBusReceiver CreateReceiver(string topicName, string subscriptionName, ServiceBusReceiverOptions options) => Create($"{topicName}/Subscriptions/{subscriptionName}", options);
		Task<ServiceBusSessionReceiver> Next(string path, ServiceBusSessionReceiverOptions options, CancellationToken token)
		{
			Assert(options.ReceiveMode == ServiceBusReceiveMode.ReceiveAndDelete && options.PrefetchCount == 0 && !options.EnableNonExclusiveSession, "Selected session ReceiveAndDelete");
			Path = path;
			NextSession = true;
			Token = token;
			if (Fail)
				throw new ServiceBusException("SECRET timeout", ServiceBusFailureReason.ServiceTimeout);
			return Task.FromResult<ServiceBusSessionReceiver>(new Session(this));
		}
		public override Task<ServiceBusSessionReceiver> AcceptSessionAsync(string queueName, string sessionId, ServiceBusSessionReceiverOptions options, CancellationToken cancellationToken = default) => sessionId == "selected" ? Next(queueName, options, cancellationToken) : throw new Exception("Wrong session");
		public override Task<ServiceBusSessionReceiver> AcceptSessionAsync(string topicName, string subscriptionName, string sessionId, ServiceBusSessionReceiverOptions options, CancellationToken cancellationToken = default) => sessionId == "selected" ? Next($"{topicName}/Subscriptions/{subscriptionName}", options, cancellationToken) : throw new Exception("Wrong session");
		public override ValueTask DisposeAsync()
		{
			Disposed = true;
			return ValueTask.CompletedTask;
		}
	}
	sealed class Receiver(Client client) : ServiceBusReceiver
	{
		public override Task<IReadOnlyList<ServiceBusReceivedMessage>> ReceiveMessagesAsync(int maxMessages, TimeSpan? maxWaitTime = null, CancellationToken cancellationToken = default)
		{
			Assert(maxMessages == 1 && maxWaitTime == TimeSpan.FromSeconds(2), "Bounded receive");
			client.Received++;
			client.Token = cancellationToken;
			return Task.FromResult<IReadOnlyList<ServiceBusReceivedMessage>>([ServiceBusModelFactory.ServiceBusReceivedMessage()]);
		}
		public override Task CompleteMessageAsync(ServiceBusReceivedMessage message, CancellationToken cancellationToken = default)
		{
			client.Completed++;
			client.Token = cancellationToken;
			return Task.CompletedTask;
		}
		public override ValueTask DisposeAsync()
		{
			client.ReceiverDisposed = true;
			return ValueTask.CompletedTask;
		}
	}
	sealed class Session(Client client) : ServiceBusSessionReceiver
	{
		public override string SessionId => "selected";
		public override DateTimeOffset SessionLockedUntil => DateTimeOffset.UtcNow.AddMinutes(1);
		public override Task RenewSessionLockAsync(CancellationToken cancellationToken = default)
		{
			client.Renewed = true;
			return Task.CompletedTask;
		}
		public override ValueTask DisposeAsync()
		{
			client.ReceiverDisposed = true;
			return ValueTask.CompletedTask;
		}
	}
}
