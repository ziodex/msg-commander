using System.Runtime.CompilerServices;
using Azure.Messaging.ServiceBus;
using Azure.Messaging.ServiceBus.Administration;
using MsgCommander.Host;

static class SessionAdapterChecks
{
	static void Assert(bool value, string label)
	{
		if (!value)
			throw new Exception(label);
	}
	public static async Task<int> Run()
	{
		var client = new Client();
		var dedicated = new List<Client>();
		await using var gateway = new AzureServiceBusGateway(new Admin(), client, () => { var owned = new Client(); dedicated.Add(owned); return owned; });
		foreach (var target in new EntityTarget[] { new("queue", "sessions"), new("subscription", "audit", "events") })
		{
			using var cancel = new CancellationTokenSource();
			var ids = new List<string>();
			await foreach (var id in gateway.ListSessionsAsync(target, cancel.Token))
				ids.Add(id);
			Assert(ids.SequenceEqual(new[] { "active", "state-only" }) && client.ListToken == cancel.Token, "SDK listing preserves cancellation and state-only IDs");
			Assert(client.Path == (target.Kind == "queue" ? "sessions" : "events/Subscriptions/audit"), "List queue/subscription routing");
			Assert(client.Accepted == 0 && client.Received == 0 && client.ListDisposed == dedicated.Count + 1, "Listing neither accepts nor receives, iterator disposed");
			await using (var owned = await gateway.OpenReceiverAsync(target, "active", "state-only", default))
			{
				var spy = dedicated[^1];
				Assert(spy.Accepted == 1 && spy.Received == 0 && owned.SessionId == "state-only", "Accept is explicit, without receive");
				Assert(owned.SessionLockedUntil > DateTimeOffset.UtcNow, "Expose actual session lock");
				Assert(await owned.GetSessionStateAsync(default) is null, "No state remains null");
				var bytes = new BinaryData(new byte[] { 0, 255, 65 });
				await owned.SetSessionStateAsync(MessageBody.FromBytes(bytes.ToMemory()), default);
				Assert((await owned.GetSessionStateAsync(default))!.ToMemory().Span.SequenceEqual(bytes.ToMemory().Span), "Binary state exact");
				await owned.SetSessionStateAsync(MessageBody.FromBytes(Array.Empty<byte>()), default);
				Assert((await owned.GetSessionStateAsync(default)) is { } empty && empty.ToMemory().Length == 0, "Empty state is distinct from null in the adapter");
				await owned.SetSessionStateAsync(null, default);
				Assert(await owned.GetSessionStateAsync(default) is null && spy.StateWrites == 3, "Clear passes null");
				var before = owned.SessionLockedUntil;
				await owned.RenewSessionLockAsync(default);
				Assert(owned.SessionLockedUntil > before && spy.Renewed == 1, "Renew entire session without a message handle");
				await owned.ReceiveAsync(1, TimeSpan.FromSeconds(2), default);
				Assert(spy.Accepted == 1 && spy.Received == 1, "Receive reuses accepted receiver");
			}
			Assert(dedicated[^1].Disposed && dedicated[^1].ReceiverDisposed, "Dispose session and dedicated client");
		}
		try
		{
			gateway.ListSessionsAsync(new("topic", "events"), default);
			throw new Exception("Accepted topic sessions");
		}
		catch (OperationException) { }
		using var aborted = new CancellationTokenSource();
		aborted.Cancel();
		try
		{
			await foreach (var _ in gateway.ListSessionsAsync(new("queue", "sessions"), aborted.Token))
			{
			}
			throw new Exception("Cancellation ignored");
		}
		catch (OperationCanceledException) { }
		Console.WriteLine("Session adapter checks passed");
		return 0;
	}
	sealed class Admin : ServiceBusAdministrationClient
	{
	}
	sealed class Client : ServiceBusClient
	{
		public string? Path, Id;
		public int Accepted, Received, StateWrites, Renewed, ListDisposed;
		public bool Disposed, ReceiverDisposed;
		public CancellationToken ListToken;
		public BinaryData? State;
		public DateTimeOffset Until = DateTimeOffset.UtcNow.AddMinutes(1);
		public override IAsyncEnumerable<string> GetMessageSessionsAsync(string queueName, CancellationToken cancellationToken = default) => List(queueName, cancellationToken);
		public override IAsyncEnumerable<string> GetMessageSessionsAsync(string topicName, string subscriptionName, CancellationToken cancellationToken = default) => List($"{topicName}/Subscriptions/{subscriptionName}", cancellationToken);
		async IAsyncEnumerable<string> List(string path, [EnumeratorCancellation] CancellationToken cancellation)
		{
			Path = path;
			ListToken = cancellation;
			try
			{
				cancellation.ThrowIfCancellationRequested();
				await Task.Yield();
				yield return "active";
				yield return "state-only";
			}
			finally { ListDisposed++; }
		}
		Task<ServiceBusSessionReceiver> Accept(string path, string id, ServiceBusSessionReceiverOptions options)
		{
			Assert(options.PrefetchCount == 0 && options.ReceiveMode == ServiceBusReceiveMode.PeekLock && !options.EnableNonExclusiveSession, "Exclusive PeekLock and no prefetch");
			Path = path;
			Id = id;
			Accepted++;
			return Task.FromResult<ServiceBusSessionReceiver>(new Receiver(this));
		}
		public override Task<ServiceBusSessionReceiver> AcceptSessionAsync(string queueName, string sessionId, ServiceBusSessionReceiverOptions options, CancellationToken cancellationToken = default) => Accept(queueName, sessionId, options);
		public override Task<ServiceBusSessionReceiver> AcceptSessionAsync(string topicName, string subscriptionName, string sessionId, ServiceBusSessionReceiverOptions options, CancellationToken cancellationToken = default) => Accept($"{topicName}/Subscriptions/{subscriptionName}", sessionId, options);
		public override ValueTask DisposeAsync()
		{
			Disposed = true;
			return ValueTask.CompletedTask;
		}
	}
	sealed class Receiver(Client client) : ServiceBusSessionReceiver
	{
		public override string SessionId => client.Id!;
		public override DateTimeOffset SessionLockedUntil => client.Until;
		public override Task<BinaryData> GetSessionStateAsync(CancellationToken cancellationToken = default) => Task.FromResult(client.State!);
		public override Task SetSessionStateAsync(BinaryData sessionState, CancellationToken cancellationToken = default)
		{
			client.State = sessionState;
			client.StateWrites++;
			return Task.CompletedTask;
		}
		public override Task RenewSessionLockAsync(CancellationToken cancellationToken = default)
		{
			client.Renewed++;
			client.Until = DateTimeOffset.UtcNow.AddMinutes(5);
			return Task.CompletedTask;
		}
		public override Task<IReadOnlyList<ServiceBusReceivedMessage>> ReceiveMessagesAsync(int maxMessages, TimeSpan? maxWaitTime = null, CancellationToken cancellationToken = default)
		{
			client.Received++;
			return Task.FromResult<IReadOnlyList<ServiceBusReceivedMessage>>([]);
		}
		public override ValueTask DisposeAsync()
		{
			client.ReceiverDisposed = true;
			return ValueTask.CompletedTask;
		}
	}
}
