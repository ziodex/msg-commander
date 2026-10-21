using System.Text.Json;
using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Consumer;
using Azure.Messaging.EventHubs.Primitives;
using MsgCommander.Host;

static class EventHubsAdapterChecks
{
	static void Assert(bool condition, string label)
	{
		if (!condition)
			throw new Exception(label);
	}
	static EventPosition Position(string json) => AzureEventPositions.ToSdk(EventHubsValidation.Position(EventHubsRequests.Position(JsonDocument.Parse(json).RootElement)));
	public static async Task<int> Run()
	{
		var options = AzureEventHubsGateway.ReaderOptions();
		Assert(options.PrefetchCount == 0 && options.OwnerLevel is null && options.ConnectionOptions.TransportType == EventHubsTransportType.AmqpWebSockets && options.RetryOptions.MaximumRetries == 0, "Non-exclusive reader, bounded buffering, port 443, no automatic retries");
		Assert(AzureEventHubsGateway.ConsumerOptions().RetryOptions.MaximumRetries == 0, "Metadata queries have no automatic retries");
		Assert(Position("{\"kind\":\"earliest\"}").Equals(EventPosition.Earliest) && Position("{\"kind\":\"latest\"}").Equals(EventPosition.Latest), "Earliest/latest map to SDK positions");
		var sequence = Position("{\"kind\":\"sequence\",\"value\":\"9223372036854775807\",\"inclusive\":false}");
		Assert(sequence.Equals(EventPosition.FromSequenceNumber(long.MaxValue, false)), "Exact Int64 sequence and exclusivity");
		var offset = Position("{\"kind\":\"offset\",\"value\":\"opaque:offset\",\"inclusive\":true}");
		Assert(offset.Equals(EventPosition.FromOffset("opaque:offset", true)), "Opaque offset and inclusivity");
		Assert(Position("{\"kind\":\"time\",\"value\":\"2026-10-11T12:00:00+02:00\"}").Equals(EventPosition.FromEnqueuedTime(FixtureEventHubsGateway.Time)), "Enqueued time normalized to UTC");
		var receiver = new Receiver();
		await using (var reader = new AzureEventHubReader(receiver))
		{
			using var stop = new CancellationTokenSource();
			var items = await reader.ReadAsync(TimeSpan.FromMilliseconds(321), stop.Token);
			Assert(receiver.Count == 1 && receiver.Wait == TimeSpan.FromMilliseconds(321) && receiver.Token == stop.Token && items[0] is AzureReceivedEvent wrapped && ReferenceEquals(wrapped.Message, receiver.Item), "One-event SDK batch, wait and cancellation forwarded, original bytes retained");
		}
		Assert(receiver.Disposed == 1, "Reader disposed exactly once");
		var profile = new ConnectionProfile(Guid.NewGuid().ToString(), "Offline", "event-hubs", "fixture.servicebus.windows.net", "sas", "", "", "Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Listen;SharedAccessKey=ZmFrZQ==;EntityPath=telemetry");
		await using var production = await new AzureEventHubsGatewayFactory().ConnectAsync(profile, null, _ => Task.CompletedTask, default);
		try
		{
			await production.GetHubAsync("other", default);
			throw new Exception("Accepted another EntityPath");
		}
		catch (OperationException) { }
		try
		{
			await new AzureEventHubsGatewayFactory().ConnectAsync(profile with
			{
				Namespace = "another.servicebus.windows.net"
			}, null, _ => Task.CompletedTask, default);
			throw new Exception("Accepted mismatched endpoint");
		}
		catch (OperationException) { }
		try
		{
			new EventHubsManagementContext(FixtureEventHubsGateway.ResourceId, "tenant", Guid.NewGuid().ToString()).Validate("another.servicebus.windows.net");
			throw new Exception("Accepted mismatched ARM namespace");
		}
		catch (OperationException) { }
		await using var fixture = new FixtureEventHubsGateway(profile, new(FixtureEventHubsGateway.ResourceId, "tenant", Guid.NewGuid().ToString()));
		var first = await fixture.ListAsync("hubs", "", null, default);
		Assert(first.Items[0].Name == "telemetry" && first.Items[0].PartitionCount == 2 && first.Items[0].Status == "Active", "ARM metadata projection");
		Assert((await fixture.ListAsync("hubs", "", first.ContinuationToken, default)).Items.Single().Name == "archive", "SDK page continuation");
		var groups = await fixture.ListAsync("groups", "telemetry", null, default);
		Assert(groups.Items[0].Name == "$Default" && groups.Items[0].UserMetadata == "Fixture consumer group", "ARM consumer group projection");
		Assert((await fixture.ListAsync("groups", "telemetry", groups.ContinuationToken, default)).Items.Single().Name == "audit", "SDK group continuation");
		Assert(fixture.Wire.Paths.All(p => p.StartsWith(FixtureEventHubsGateway.ResourceId + "/eventhubs")), "Scoped management requests only");
		var partition = await fixture.GetPartitionAsync("telemetry", "0", default);
		Assert(partition.BeginningSequence == "9007199254740993" && partition.LastOffset == "offset:three", "Exact partition metadata");
		var empty = await fixture.GetPartitionAsync("telemetry", "1", default);
		Assert(empty.IsEmpty && empty.BeginningSequence is null && empty.LastSequence is null && empty.LastOffset is null, "Empty partition avoids fabricated sequence numbers");
		var counter = new EventStatisticsCounter();
		Assert(counter.Snapshot() == new EventOperationStatistics(0, 0, 0, 0, null, null, 0, 0, null, null), "No fabricated samples before calls");
		counter.Call(2, true);
		counter.Call(8, true, true);
		counter.Call(100, false);
		Parallel.For(0, 1000, i => counter.Body(i % 2 == 0 ? 0 : 10));
		Assert(counter.Snapshot() == new EventOperationStatistics(2, 1, 1, 10, 2, 8, 1000, 5000, 0, 10), "Deterministic timings, failed calls excluded, concurrent byte totals and empty bodies");
		try
		{
			await counter.Measure<int>(() => Task.FromException<int>(new IOException("fixture")));
		}
		catch (IOException) { }
		Assert(counter.Snapshot().FailedCalls == 2 && counter.Snapshot().SuccessfulCalls == 2, "Failed measured call counted exactly once");
		Assert(await counter.Measure(() => Task.FromResult(0), value => value == 0) == 0 && counter.Snapshot().EmptyCalls == 2, "Empty call timing retained");
		await EventHubsStatisticsChecks.Run();
		Console.WriteLine("Event Hubs adapter checks passed");
		return 0;
	}
	sealed class Receiver : PartitionReceiver
	{
		public int Count, Disposed;
		public TimeSpan Wait;
		public CancellationToken Token;
		public EventData Item = FixtureEventHubsGateway.Events("telemetry")[1];
		public override Task<IEnumerable<EventData>> ReceiveBatchAsync(int maximumMessageCount, TimeSpan maximumWaitTime, CancellationToken cancellationToken = default)
		{
			Count = maximumMessageCount;
			Wait = maximumWaitTime;
			Token = cancellationToken;
			return Task.FromResult<IEnumerable<EventData>>([Item]);
		}
		public override ValueTask DisposeAsync()
		{
			Disposed++;
			return ValueTask.CompletedTask;
		}
	}
}
