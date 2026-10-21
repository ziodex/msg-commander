using Azure.Messaging.ServiceBus;
using Azure.Messaging.ServiceBus.Administration;
using MsgCommander.Host;
using MsgCommander.Infrastructure.ServiceBus.TestJobs;
using LatencySummary = MsgCommander.Domain.ServiceBus.TestJobs.LatencySummary;

static class TestJobAdapterChecks
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
		var dispatched = 0;
		var acknowledged = 0;
		await using (var sender = gateway.OpenTestSender(new("topic", "events")))
		{
			var message = new TestJobMessage(System.Text.Encoding.UTF8.GetBytes("test"), "application/json", "session-1", "job-1", "job", 1);
			await sender.SendBatchAsync([message], (_, n) => dispatched += n, (_, n, ms) => { acknowledged += n; Assert(ms >= 0, "Nonnegative acknowledgement latency"); }, default);
			await sender.SendBatchAsync([message], (_, n) => dispatched += n, (_, n, _) => acknowledged += n, default);
			Assert(client.Created == 1 && client.Sends == 2 && client.Path == "events" && dispatched == 2 && acknowledged == 2 && client.Disposals == 0, "Reuse one owned sender");
			Assert(client.Last?.MessageId == message.MessageId && client.Last.SessionId == "session-1" && client.Last.Body.ToString() == "test" && (string)client.Last.ApplicationProperties["commander-test-job"] == "job" && (int)client.Last.ApplicationProperties["commander-test-index"] == 1, "Preserve message and session metadata");
			client.Oversized = true;
			try
			{
				await sender.SendBatchAsync([message], (_, n) => dispatched += n, (_, n, _) => acknowledged += n, default);
				throw new Exception("Expected preflight rejection");
			}
			catch (TestJobException) { }
			Assert(dispatched == 2 && client.Sends == 2, "Oversized message is rejected before dispatch");
			client.Oversized = false;
			using var cancelled = new CancellationTokenSource();
			cancelled.Cancel();
			try
			{
				await sender.SendBatchAsync([message], (_, n) => dispatched += n, (_, n, _) => acknowledged += n, cancelled.Token);
				throw new Exception("Expected cancellation");
			}
			catch (OperationCanceledException) { }
			Assert(dispatched == 2 && client.Sends == 2, "Cancelled preflight does not write");
			await sender.SendBatchAsync(Enumerable.Repeat(message, 5).ToArray(), (_, n) => dispatched += n,
				(_, n, _) => acknowledged += n, default);
			Assert(client.BatchSizes.SequenceEqual(new[] { 1, 1, 2, 2, 1 }) && dispatched == 7 && acknowledged == 7,
				"Split at negotiated capacity, acknowledge each real batch exactly once");
			client.FailSendAt = client.Sends + 2;
			try
			{
				await sender.SendBatchAsync(Enumerable.Repeat(message, 5).ToArray(), (_, n) => dispatched += n,
					(_, n, _) => acknowledged += n, default);
				throw new Exception("Expected lost acknowledgement");
			}
			catch (TestJobTransportException error) { Assert(!error.Rejected, "Lost acknowledgement remains uncertain"); }
			Assert(dispatched == 11 && acknowledged == 9 && client.Sends == client.FailSendAt,
				"Keep the first split batch acknowledgement; never dispatch the remaining batch or retry an uncertain send");
		}
		Assert(client.Disposals == 1, "Dispose the sender once at job end");
		try
		{
			gateway.OpenTestSender(new("subscription", "audit", "events"));
			throw new Exception("Expected destination rejection");
		}
		catch (OperationException) { }
		Assert(client.Created == 1, "Invalid target never opens a sender");
		var latency = LatencySummary.From(Enumerable.Range(1, 100).Select(n => (double)n).ToList());
		Assert(latency == new LatencySummary(100, 1, 50.5, 50, 95, 99, 100), "Exact nearest-rank percentiles and arithmetic mean");
		Assert(LatencySummary.From([]) == new LatencySummary(0, null, null, null, null, null, null), "Empty timing has no invented latency");
		await ReceiverOwnership();
		Console.WriteLine("Test job adapter checks passed");
		return 0;
	}
	static async Task ReceiverOwnership()
	{
		var sdk = new Receiver();
		await using var first = new MessageTestJobReceiver(sdk);
		await using var other = new MessageTestJobReceiver(new Receiver());
		var delivery = (await first.ReceiveAsync(1, TimeSpan.FromSeconds(1), default))[0];
		Assert(delivery.SequenceNumber == 9007199254740993L, "Keep exact sequence precision across the application port");
		try
		{
			await other.SettleAsync(delivery, "complete", "", "", default);
			throw new Exception("Expected receiver ownership rejection");
		}
		catch (TestJobException) { }
		try
		{
			await first.SettleAsync(delivery with
			{
				SequenceNumber = delivery.SequenceNumber + 1
			}, "complete", "", "", default);
			throw new Exception("Expected altered delivery rejection");
		}
		catch (TestJobException) { }
		Assert(sdk.Settlements == 0, "Foreign or altered handles never dispatch settlement");
		await first.SettleAsync(delivery, "complete", "", "", default);
		Assert(sdk.Settlements == 1, "Settle exactly the owned SDK message");
		try
		{
			await first.SettleAsync(delivery, "complete", "", "", default);
			throw new Exception("Expected consumed handle rejection");
		}
		catch (TestJobException) { }
		delivery = (await first.ReceiveAsync(1, TimeSpan.FromSeconds(1), default))[0];
		await first.ReceiveAsync(1, TimeSpan.FromSeconds(1), default);
		try
		{
			await first.SettleAsync(delivery, "complete", "", "", default);
			throw new Exception("Expected old batch handle rejection");
		}
		catch (TestJobException) { }
		Assert(sdk.Settlements == 1, "Consumed and replaced batch handles never replay settlement");
	}
	sealed class Receiver : ITestJobMessageReceiver
	{
		private readonly ReceivedMessage message = AzureReceivedMessage.Snapshot(ServiceBusModelFactory.ServiceBusReceivedMessage(messageId: "same-id", sequenceNumber: 9007199254740993L));
		public int Settlements;
		public DateTimeOffset? SessionLockedUntil => null;
		public Task RenewSessionLockAsync(CancellationToken cancellation) => Task.CompletedTask;
		public Task<IReadOnlyList<ReceivedMessage>> ReceiveAsync(int count, TimeSpan wait, CancellationToken cancellation) => Task.FromResult<IReadOnlyList<ReceivedMessage>>([message]);
		public Task SettleAsync(ReceivedMessage value, string action, string reason, string description, CancellationToken cancellation)
		{
			Assert(ReferenceEquals(value, message), "Keep SDK lock ownership within the adapter");
			Settlements++;
			return Task.CompletedTask;
		}
		public ValueTask DisposeAsync() => ValueTask.CompletedTask;
	}
	sealed class Admin : ServiceBusAdministrationClient
	{
	}
	sealed class Client : ServiceBusClient
	{
		public int Created, Sends, Disposals;
		public int? FailSendAt;
		public string? Path;
		public bool Oversized;
		public ServiceBusMessage? Last;
		public List<int> BatchSizes = [];
		public override ValueTask DisposeAsync() => ValueTask.CompletedTask;
		public override ServiceBusSender CreateSender(string queueOrTopicName)
		{
			Created++;
			Path = queueOrTopicName;
			return new Sender(this);
		}
	}
	sealed class Sender(Client client) : ServiceBusSender
	{
		public override ValueTask<ServiceBusMessageBatch> CreateMessageBatchAsync(CancellationToken cancellationToken = default)
		{
			cancellationToken.ThrowIfCancellationRequested();
			var messages = new List<ServiceBusMessage>();
			return ValueTask.FromResult(ServiceBusModelFactory.ServiceBusMessageBatch(262144, messages, tryAddCallback: message =>
			{
				client.Last = message;
				return !client.Oversized && messages.Count < 2;
			}));
		}
		public override Task SendMessagesAsync(ServiceBusMessageBatch batch, CancellationToken cancellationToken = default)
		{
			client.BatchSizes.Add(batch.Count);
			client.Sends++;
			if (client.Sends == client.FailSendAt)
				throw new ServiceBusException("Lost acknowledgement", ServiceBusFailureReason.ServiceCommunicationProblem);
			return Task.CompletedTask;
		}
		public override ValueTask DisposeAsync()
		{
			client.Disposals++;
			return ValueTask.CompletedTask;
		}
	}
}
