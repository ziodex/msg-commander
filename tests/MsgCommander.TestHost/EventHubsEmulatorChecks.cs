using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Consumer;
using Azure.Messaging.EventHubs.Primitives;
using Azure.Messaging.EventHubs.Producer;
using MsgCommander.Infrastructure.ResourceConfiguration;

static class EventHubsEmulatorChecks
{
	const string Stream = "refactor-stream", Listen = "refactor-listen";
	const string Emulator = "Endpoint=sb://localhost:5673;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;";
	static string Id() => Guid.NewGuid().ToString();
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	static EventPositionSpec After(EventHubPartition value) => value.IsEmpty ? new("earliest") : new("sequence", value.LastSequence, false);
	static async Task<string> MarkerSequence(IEventHubsGateway gateway, string partition, EventHubPartition before, string messageId, CancellationToken cancellation)
	{
		var position = before.IsEmpty ? StreamPosition.Create("earliest") : StreamPosition.Create("sequence", before.LastSequence, false);
		await using var reader = gateway.OpenReader(Listen, "$Default", partition, position);
		var scanned = 0;
		while (scanned < 256)
		{
			cancellation.ThrowIfCancellationRequested();
			var batch = await reader.ReadAsync(TimeSpan.FromMilliseconds(250), cancellation);
			foreach (var item in batch)
			{
				if (item.MessageId == messageId)
					return item.SequenceNumber.ToString(System.Globalization.CultureInfo.InvariantCulture);
				scanned++;
			}
		}
		throw new Exception("The isolated listener marker was not found within 256 retained events.");
	}
	public static async Task<int> Run()
	{
		using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(100));
		var token = deadline.Token;
		var factory = new Factory();
		await using var owner = new EventHubsConnectionOwner(factory, new AzureEventHubsFailureClassifier(), new AzureConfigurationFailureClassifier());
		var profile = new ConnectionProfile(Id(), "Docker Event Hubs", "event-hubs", "localhost", "sas", "", "", Emulator);
		var connection = await owner.ConnectAsync(() => new(profile, Stream, "read", null), null, token);
		await owner.ExecuteAsync(connection.ConnectionId, EventHubOperation.Shared, Stream, null, async (context, ct) =>
		{
			var before = await context.Gateway.GetPartitionAsync(Stream, "0", ct);
			var marker = Id();
			var drafts = new EventDraft[] {
				new(Convert.ToBase64String(new byte[] { 0, 255, 128, 65 }), "application/octet-stream", marker, [new("exact", "int64", "9007199254740993"), new("label", "string", "binary")]),
				new(Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("{\"kind\":\"refactor\"}")), "application/json", marker, [new("label", "string", "json")])
			};
			var send = new EventHubSendRequest(Id(), Stream, new("partition", "0"), drafts, 3, 2, 10, 0, true);
			var sent = await context.Send.ExecuteAsync(send, "docker-send", _ => Task.CompletedTask, ct);
			Assert(sent.Status == "completed" && sent.Confirmed == 6 && sent.ConfirmedBatches == 3 && sent.Uncertain == 0 && sent.Statistics?.BodyEvents == 6, "Broker confirms three SDK batches without uncertainty");
			Assert(ReferenceEquals(context.Send.CheckRequest(send.Id, "docker-send"), sent), "Receipt replay does not send duplicate events");
			var read = new EventHubReadRequest(Id(), Stream, "$Default", "0", After(before), 6, 10);
			var received = await context.Read.ExecuteAsync(read, "docker-read", _ => Task.CompletedTask, ct);
			Assert(received.Status == "completed" && received.Received == 6 && received.Items.All(x => x.SnapshotId is not null) && received.Statistics?.SuccessfulCalls == 6, "Read retains six SDK events and measured calls");
			var binary = context.Snapshots.Inspect(received.Items[0].SnapshotId!);
			Assert(binary.MessageId == send.Id + ":1" && binary.CorrelationId == marker && binary.ApplicationProperties.Any(p => p.Name == "exact" && p.Value == "9007199254740993"), "SDK envelope retains exact typed properties and message identity");
			var body = System.Text.Json.JsonSerializer.SerializeToElement(context.Snapshots.Body(received.Items[0].SnapshotId!, 0, 65536), new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web));
			Assert(body.GetProperty("base64").GetString() == "AP+AQQ==", "Binary bytes survive broker, projection and body chunks");
			var audit = await context.Read.ExecuteAsync(read with
			{
				Id = Id(),
				ConsumerGroup = "audit"
			}, "docker-audit", _ => Task.CompletedTask, ct);
			Assert(audit.Received == 6 && audit.Items.Select(x => x.SequenceNumber).SequenceEqual(received.Items.Select(x => x.SequenceNumber)), "Independent consumer group reads the same retained stream");
			var statistics = await context.Browse.StatisticsAsync(Stream, ct);
			Assert(statistics.Partitions.Count == 2 && statistics.Partitions.All(p => p.Error is null), "Partition statistics use real broker metadata");
			Console.WriteLine("Event Hubs Docker: batching, exact properties, bytes, inspection and independent groups passed");
			// Fix a local checkpoint before publishing to four partitions.
			var hub = await context.Gateway.GetHubAsync(Listen, ct);
			var positions = new List<EventCheckpointPartition>();
			var markers = new List<string>();
			foreach (var partition in hub.PartitionIds)
			{
				var metadata = await context.Gateway.GetPartitionAsync(Listen, partition, ct);
				var markerId = Id();
				markers.Add(markerId + ":1");
				var value = await context.Send.ExecuteAsync(new(markerId, Listen, new("partition", partition), [drafts[0]], 1, 1, 10, 0, true), "partition-" + partition, _ => Task.CompletedTask, ct);
				Assert(value.Confirmed == 1, "Partition-targeted event confirmed");
				// Anchor to the event from this run, rather than assume namespace metadata isolates retained history.
				var sequence = await MarkerSequence(context.Gateway, partition, metadata, markerId + ":1", ct);
				positions.Add(new(partition, new("sequence", sequence, true), metadata.BeginningSequence ?? "0"));
			}
			var checkpoint = new EventCheckpoint("msg-commander/event-checkpoints", 1, connection.Namespace, Listen, "$Default", hub.CreatedAt, DateTimeOffset.UtcNow.ToString("O"), positions);
			var listening = await context.Listen.ExecuteAsync(new(Id(), connection.ConnectionId, Listen, "$Default", new("checkpoint", Checkpoint: checkpoint), 2, 4, 30, true), "docker-listen", _ => Task.CompletedTask, ct);
			if (listening.Status != "completed" || listening.Received != 4 || listening.Checkpoint is null || listening.Partitions.Any(p => p.Received != 1))
				Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new
				{
					listening.Status,
					listening.Reason,
					listening.Received,
					listening.ElapsedMs,
					listening.Summary,
					listening.Partitions,
					listening.Statistics,
					Start = positions
				}));
			Assert(listening.Status == "completed" && listening.Received == 4 && listening.Checkpoint is not null && listening.Partitions.All(p => p.Received == 1), "Two workers rotate across four partitions and advance only retained positions");
			Assert(listening.Items.Select(item => context.Snapshots.Inspect(item.SnapshotId!).MessageId).Order().SequenceEqual(markers.Order()), "Each partition retains exactly the marker published by this run");
			var resumed = await context.Listen.ExecuteAsync(new(Id(), connection.ConnectionId, Listen, "$Default", new("checkpoint", Checkpoint: listening.Checkpoint), 2, 4, 1, true), "docker-resume", _ => Task.CompletedTask, ct);
			Assert(resumed.Received == 0 && resumed.Status == "limited" && resumed.Reason == "time", "Explicit checkpoint resume does not replay retained events");
			Console.WriteLine("Event Hubs Docker: concurrent listener and explicit local checkpoint resume passed");
			return 0;
		}, token);
		await owner.ResetAsync(token);
		Assert(factory.OpenReaders == 0 && owner.Connection is null, "All SDK readers close before explicit reconnect");
		var reconnected = await owner.ConnectAsync(() => new(profile, Stream, "send", null), null, token);
		Assert(reconnected.ConnectionId != connection.ConnectionId, "Explicit reconnect publishes a new generation using producer metadata");
		Console.WriteLine("Event Hubs emulator checks passed");
		return 0;
	}
	// Only this test gateway permits emulator hosts and TCP. Production endpoint/transport policy stays in Infrastructure.
	sealed class Factory : IEventHubsGatewayFactory
	{
		public int OpenReaders;
		public Task<IEventHubsGateway> ConnectAsync(ConnectionProfile profile, EventHubsManagementContext? management, Func<DeviceCodeEvent, Task> prompt, CancellationToken token) => Task.FromResult<IEventHubsGateway>(new Gateway(this));
	}
	static EventHubConsumerClientOptions ConsumerOptions()
	{
		var options = AzureEventHubsGateway.ConsumerOptions();
		options.ConnectionOptions.TransportType = EventHubsTransportType.AmqpTcp;
		return options;
	}
	static EventHubProducerClientOptions ProducerOptions()
	{
		var options = AzureEventHubsGateway.ProducerOptions();
		options.ConnectionOptions.TransportType = EventHubsTransportType.AmqpTcp;
		return options;
	}
	sealed class Gateway(Factory owner) : IEventHubsGateway
	{
		public bool CanBrowse => false;
		public IEventHubsAdministration? Administration => null;
		public async Task<EventHubInfo> GetHubAsync(string hub, CancellationToken token, bool forSending = false)
		{
			Azure.Messaging.EventHubs.EventHubProperties value;
			if (forSending)
			{
				await using var producer = new EventHubProducerClient(Emulator, hub, ProducerOptions());
				value = await producer.GetEventHubPropertiesAsync(token);
			}
			else
			{
				await using var consumer = new EventHubConsumerClient("$Default", Emulator, hub, ConsumerOptions());
				value = await consumer.GetEventHubPropertiesAsync(token);
			}
			return new(value.Name, value.PartitionIds, MsgCommander.Application.Common.DisplayValues.Timestamp(value.CreatedOn));
		}
		public async Task<EventHubPartition> GetPartitionAsync(string hub, string partition, CancellationToken token, bool forSending = false)
		{
			await using var consumer = new EventHubConsumerClient("$Default", Emulator, hub, ConsumerOptions());
			return AzureEventHubsGateway.Project(await consumer.GetPartitionPropertiesAsync(partition, token));
		}
		public IEventHubReader OpenReader(string hub, string group, string partition, StreamPosition position)
		{
			var options = AzureEventHubsGateway.ReaderOptions();
			options.ConnectionOptions.TransportType = EventHubsTransportType.AmqpTcp;
			var reader = new AzureEventHubReader(new PartitionReceiver(group, partition, AzureEventPositions.ToSdk(position), Emulator, hub, options));
			Interlocked.Increment(ref owner.OpenReaders);
			return new TrackedReader(owner, reader);
		}
		public IEventHubSender OpenSender(string hub) => new AzureEventHubSender(new EventHubProducerClient(Emulator, hub, ProducerOptions()));
		public Task<EventHubsPage> ListAsync(string kind, string hub, string? continuation, CancellationToken token) => throw new NotSupportedException("The emulator has no ARM API.");
		public ValueTask DisposeAsync() => ValueTask.CompletedTask;
	}
	sealed class TrackedReader(Factory owner, IEventHubReader reader) : IEventHubReader
	{
		private bool closed;
		public Task<IReadOnlyList<ReceivedEvent>> ReadAsync(TimeSpan wait, CancellationToken token) => reader.ReadAsync(wait, token);
		public async ValueTask DisposeAsync()
		{
			await reader.DisposeAsync();
			if (!closed)
			{
				closed = true;
				Interlocked.Decrement(ref owner.OpenReaders);
			}
		}
	}
}
