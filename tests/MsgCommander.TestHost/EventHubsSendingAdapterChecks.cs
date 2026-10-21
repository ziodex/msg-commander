using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Producer;
using MsgCommander.Host;

static class EventHubsSendingAdapterChecks
{
	static void Assert(bool value, string label)
	{
		if (!value)
			throw new Exception(label);
	}
	public static async Task<int> Run()
	{
		var options = AzureEventHubsGateway.ProducerOptions();
		Assert(options.RetryOptions.MaximumRetries == 0 && options.ConnectionOptions.TransportType == EventHubsTransportType.AmqpWebSockets, "Producer uses port 443 without retries");
		var draft = new EventDraft("AP+AQQ==", "application/octet-stream", "correlation", [
			new("signed", "int64", "-9223372036854775808"), new("unsigned", "uint64", "18446744073709551615"),
			new("flag", "boolean", "true"), new("binary", "binary", "AP8="), new("date", "datetime", "2026-10-11T12:00:00+02:00")]);
		var data = OutgoingEvents.Build(draft, "operation:1");
		Assert(data.EventBody.ToArray().SequenceEqual(new byte[] { 0, 255, 128, 65 }) && data.MessageId == "operation:1" && data.ContentType == draft.ContentType && data.CorrelationId == "correlation", "Exact bytes and AMQP properties");
		Assert((long)data.Properties["signed"] == long.MinValue && (ulong)data.Properties["unsigned"] == ulong.MaxValue && (bool)data.Properties["flag"] && ((byte[])data.Properties["binary"]).SequenceEqual(new byte[] { 0, 255 }) && (DateTime)data.Properties["date"] == FixtureEventHubsGateway.Time.UtcDateTime, "Typed properties preserve ranges and UTC");
		var producer = new Producer();
		await using (var sender = new AzureEventHubSender(producer))
		{
			foreach (var routing in new EventRouting[] { new("automatic"), new("key", "device"), new("partition", "1") })
			{
				using var stop = new CancellationTokenSource();
				using var batch = await sender.CreateBatchAsync(routing, stop.Token);
				Assert(producer.Options!.PartitionId == (routing.Kind == "partition" ? "1" : null) && producer.Options.PartitionKey == (routing.Kind == "key" ? "device" : null), "Exclusive routing passed to SDK batch");
				Assert(batch.TryAdd(data) && !batch.TryAdd(data) && batch.Count == 1, "SDK TryAdd rejection and count forwarded");
				var dispatch = false;
				await batch.SendAsync(() => dispatch = true, stop.Token);
				Assert(dispatch && producer.Token == stop.Token && ReferenceEquals(producer.Sent, producer.Batch), "Exact SDK batch and cancellation forwarded");
				stop.Cancel();
				try
				{
					await batch.SendAsync(() => throw new Exception("Cancelled dispatch"), stop.Token);
					throw new Exception("Cancelled send accepted");
				}
				catch (OperationCanceledException) { }
			}
		}
		Assert(producer.Sends == 3 && producer.Disposed == 1, "No retries and producer disposed once");
		var profile = new ConnectionProfile(Guid.NewGuid().ToString(), "Offline", "event-hubs", "fixture.servicebus.windows.net", "sas", "", "", "Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Send;SharedAccessKey=ZmFrZQ==;EntityPath=telemetry");
		await using var gateway = await new AzureEventHubsGatewayFactory().ConnectAsync(profile, null, _ => Task.CompletedTask, default);
		try
		{
			gateway.OpenSender("other");
			throw new Exception("Accepted wrong EntityPath");
		}
		catch (OperationException) { }
		try
		{
			await gateway.GetHubAsync("other", default, true);
			throw new Exception("Accepted wrong EntityPath for metadata");
		}
		catch (OperationException) { }
		Console.WriteLine("Event Hubs sending adapter checks passed");
		return 0;
	}
	sealed class Producer : EventHubProducerClient
	{
		public CreateBatchOptions? Options;
		public EventDataBatch? Batch, Sent;
		public CancellationToken Token;
		public int Sends, Disposed;
		public override ValueTask<EventDataBatch> CreateBatchAsync(CreateBatchOptions options, CancellationToken cancellationToken = default)
		{
			Options = options;
			Token = cancellationToken;
			var events = new List<EventData>();
			Batch = EventHubsModelFactory.EventDataBatch(1024, events, options, _ => events.Count < 1);
			return ValueTask.FromResult(Batch);
		}
		public override Task SendAsync(EventDataBatch batch, CancellationToken cancellationToken = default)
		{
			Sent = batch;
			Token = cancellationToken;
			Sends++;
			return Task.CompletedTask;
		}
		public override ValueTask DisposeAsync()
		{
			Disposed++;
			return ValueTask.CompletedTask;
		}
	}
}
