using Azure.Messaging.ServiceBus;
using Azure.Messaging.ServiceBus.Administration;
using MsgCommander.Host;

static class PurgeAdapterChecks
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
				await using (var receiver = await gateway.OpenReceiverAsync(target, selector, "", cancel.Token))
				{
					var spy = clients[^1];
					Assert(spy.Path == path && spy.SubQueue == expected, "Correct queue/subscription subqueue");
					var message = (await receiver.ReceiveAsync(1, TimeSpan.FromSeconds(2), cancel.Token)).Single();
					await receiver.SettleAsync(message, "complete", "", "", cancel.Token);
					Assert(spy.Received == 1 && spy.Completed == 1 && spy.Token == cancel.Token, "One explicit completion; cancellation forwarded");
				}
				Assert(clients[^1].Disposed && clients[^1].ReceiverDisposed, "Regular purge receiver/client released");
			}
			await using (var receiver = await gateway.OpenNextSessionAsync(target, default))
			{
				Assert(clients[^1].Path == path && clients[^1].NextSession && receiver.SessionId == "next-session", "Accept next session routing");
				await receiver.RenewSessionLockAsync(default);
				Assert(clients[^1].Renewed, "Owned purge session can be renewed");
			}
			Assert(clients[^1].Disposed && clients[^1].ReceiverDisposed, "Next-session receiver/client released");
		}
		try
		{
			await gateway.OpenNextSessionAsync(new("topic", "jobs"), default);
			throw new Exception("Topic accepted");
		}
		catch (OperationException) { }
		await using var failing = new AzureServiceBusGateway(new Admin(), new Client(), () => { var c = new Client { Fail = true }; clients.Add(c); return c; });
		try
		{
			await failing.OpenNextSessionAsync(new("queue", "jobs"), default);
			throw new Exception("Failure ignored");
		}
		catch (ServiceBusException) { }
		Assert(clients[^1].Disposed, "Failed acceptance disposes the client");
		Console.WriteLine("Purge adapter checks passed");
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
			Assert(options.ReceiveMode == ServiceBusReceiveMode.PeekLock && options.PrefetchCount == 0, "Purge never uses ReceiveAndDelete or prefetch");
			Path = path;
			SubQueue = options.SubQueue;
			return new Receiver(this);
		}
		public override ServiceBusReceiver CreateReceiver(string queueName, ServiceBusReceiverOptions options) => Create(queueName, options);
		public override ServiceBusReceiver CreateReceiver(string topicName, string subscriptionName, ServiceBusReceiverOptions options) => Create($"{topicName}/Subscriptions/{subscriptionName}", options);
		Task<ServiceBusSessionReceiver> Next(string path, ServiceBusSessionReceiverOptions options, CancellationToken token)
		{
			Assert(options.ReceiveMode == ServiceBusReceiveMode.PeekLock && options.PrefetchCount == 0 && !options.EnableNonExclusiveSession, "Next-session exclusive PeekLock");
			Path = path;
			NextSession = true;
			Token = token;
			if (Fail)
				throw new ServiceBusException("SECRET timeout", ServiceBusFailureReason.ServiceTimeout);
			return Task.FromResult<ServiceBusSessionReceiver>(new Session(this));
		}
		public override Task<ServiceBusSessionReceiver> AcceptNextSessionAsync(string queueName, ServiceBusSessionReceiverOptions options, CancellationToken cancellationToken = default) => Next(queueName, options, cancellationToken);
		public override Task<ServiceBusSessionReceiver> AcceptNextSessionAsync(string topicName, string subscriptionName, ServiceBusSessionReceiverOptions options, CancellationToken cancellationToken = default) => Next($"{topicName}/Subscriptions/{subscriptionName}", options, cancellationToken);
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
		public override string SessionId => "next-session";
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
