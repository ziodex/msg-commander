using MsgCommander.Infrastructure.ResourceConfiguration;

static class EventHubsBoundaryChecks
{
	static string Id() => Guid.NewGuid().ToString();
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	static async Task Reject(Func<Task> run, OperationFailure expected)
	{
		try
		{
			await run();
		}
		catch (OperationException error) when (error.Failure == expected) { return; }
		throw new Exception("Expected " + expected);
	}
	static ConnectionProfile Profile() => new(Id(), "events", "event-hubs", "fixture.servicebus.windows.net", "sas", "", "", "fixture-only");
	public static async Task<int> Run()
	{
		var factory = new Factory();
		await using var owner = new EventHubsConnectionOwner(factory, new AzureEventHubsFailureClassifier(), new AzureConfigurationFailureClassifier());
		var request = new EventHubConnect(Profile(), "events", "read", null);
		var first = await owner.ConnectAsync(() => request, _ => Task.CompletedTask, default);
		var gateway = factory.Last!;
		EventHubsConnectionContext? oldContext = null;
		var readId = Id();
		var sendId = Id();
		await owner.ExecuteAsync(first.ConnectionId, EventHubOperation.Read, "events", _ => Task.CompletedTask, async (context, token) =>
		{
			oldContext = context;
			var read = new EventHubReadRequest(readId, "events", "$Default", "0", new("earliest"), 1, 1);
			var receipt = await context.Read.ExecuteAsync(read, "read", _ => Task.CompletedTask, token);
			Assert(receipt.Received == 1 && receipt.Items.Single().SequenceNumber == "9007199254740993" && receipt.Items.Single().Offset == "opaque:offset", "Exact sequence and opaque offset cross SDK-free ports");
			var snapshotId = receipt.Items.Single().SnapshotId!;
			Assert(context.Snapshots.Inspect(snapshotId).Summary == receipt.Items.Single(), "Connection owns inspected snapshot");
			Assert(ReferenceEquals(context.Read.CheckRequest(readId, "read"), receipt), "Read receipt replay bypasses acquisition");
			await Reject(() => Task.FromResult(context.Read.CheckRequest(readId, "different")), OperationFailure.InvalidInput);
			gateway.FailOpen = true;
			var failed = await context.Read.ExecuteAsync(read with
			{
				Id = Id()
			}, "open-failure", _ => Task.CompletedTask, token);
			Assert(failed.Status == "failed" && context.Snapshots.Inspect(snapshotId).Summary.SequenceNumber == "9007199254740993", "Failed acquisition preserves prior snapshot");
			gateway.FailOpen = false;
			using var cancelled = new CancellationTokenSource();
			gateway.AfterRead = cancelled.Cancel;
			var acknowledged = await context.Read.ExecuteAsync(read with
			{
				Id = Id()
			}, "acknowledged", _ => Task.CompletedTask, cancelled.Token);
			Assert(acknowledged.Received == 1 && acknowledged.Status == "completed", "Returned event wins cancellation race");
			gateway.AfterRead = null;
			gateway.SendUnknown = true;
			var send = new EventHubSendRequest(sendId, "events", new("automatic"), [new("AA==", "", "", [])], 2, 2, 1, 0, true);
			var unknown = await context.Send.ExecuteAsync(send, "send", _ => Task.CompletedTask, token);
			Assert(unknown.Status == "unknown" && unknown.Confirmed == 0 && unknown.Uncertain == 2 && gateway.Sends == 1, "Dispatched batch retains truthful uncertain count without retry");
			Assert(ReferenceEquals(context.Send.CheckRequest(sendId, "send"), unknown) && gateway.Sends == 1, "Send receipt replay cannot dispatch again");
			gateway.FailReaderClose = 1;
			var unclosed = await context.Read.ExecuteAsync(read with
			{
				Id = Id()
			}, "unclosed", _ => Task.CompletedTask, token);
			Assert(unclosed.CleanupWarning is not null, "Unclosed endpoint warning is retained");
			await Reject(() => context.Read.ExecuteAsync(read with { Id = Id() }, "blocked", _ => Task.CompletedTask, token), OperationFailure.OperationBlocked);
			return 0;
		}, default);
		await owner.ResetAsync(default);
		Assert(gateway.OpenReaders == 0 && gateway.Closes == 1 && oldContext!.Read.GetResult(readId) is null && oldContext.Send.GetResult(sendId) is null, "Explicit reset retries endpoint cleanup before disposing gateway and clears receipts");
		var second = await owner.ConnectAsync(() => request, _ => Task.CompletedTask, default);
		Assert(second.ConnectionId != first.ConnectionId, "Connection generation changes");
		await Reject(() => owner.ExecuteAsync(first.ConnectionId, EventHubOperation.Shared, null, null, (_, _) => Task.FromResult(0), default), OperationFailure.ConnectionExpired);
		await Reject(() => gateway.Prompt!(new("OLD", "later")), OperationFailure.AuthenticationRequired);
		await owner.ExecuteAsync(second.ConnectionId, EventHubOperation.Shared, null, null, async (_, _) =>
		{
			await Reject(() => gateway.Prompt!(new("OLD", "later")), OperationFailure.AuthenticationRequired);
			return 0;
		}, default);
		// A cancelled waiter must never replace the active generation or run its parser.
		using (var cancelled = new CancellationTokenSource())
		{
			cancelled.Cancel();
			bool parsed = false;
			try
			{
				await owner.ConnectAsync(() => { parsed = true; return request; }, null, cancelled.Token);
				throw new Exception("Cancelled connect accepted");
			}
			catch (OperationCanceledException) { }
			Assert(!parsed && owner.Connection == second, "Cancelled connect leaves current generation untouched");
		}
		// Candidate cleanup failure retains ownership and blocks the next connection until explicit cleanup succeeds.
		factory.FailProbe = true;
		factory.FailGatewayClose = 2;
		try
		{
			await owner.ConnectAsync(() => request, null, default);
			throw new Exception("Failed probe accepted");
		}
		catch (IOException) { }
		var unpublished = factory.Last!;
		factory.FailProbe = false;
		factory.FailGatewayClose = 0;
		await Reject(() => owner.ConnectAsync(() => request, null, default), OperationFailure.OperationBlocked);
		Assert(unpublished.Closes == 2 && owner.Connection is null, "Failed unpublished candidate remains owned");
		var recovered = await owner.ConnectAsync(() => request, null, default);
		Assert(unpublished.Closes == 3 && recovered.ConnectionId != second.ConnectionId, "Explicit reconnect retries retained cleanup");
		// IoT must stay scoped to the built-in endpoint across all application entry points.
		var iotProfile = request.Profile with
		{
			Service = "iot-hub",
			Secret = "Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=service;SharedAccessKey=ZmFrZQ==;EntityPath=events"
		};
		var iot = await owner.ConnectAsync(() => request with { Profile = iotProfile }, null, default);
		foreach (var operation in new[] { EventHubOperation.Send, EventHubOperation.Administration, EventHubOperation.Browse })
			await Reject(() => owner.ExecuteAsync(iot.ConnectionId, operation, "events", null, (_, _) => Task.FromResult(0), default), OperationFailure.InvalidInput);
		await Reject(() => owner.ExecuteAsync(iot.ConnectionId, EventHubOperation.Read, "other", null, (_, _) => Task.FromResult(0), default), OperationFailure.InvalidInput);
		await Reject(() => owner.ExecuteAsync(iot.ConnectionId, EventHubOperation.Configuration, "events", null, (context, _) => Task.FromResult(context.Configuration), default), OperationFailure.InvalidInput);
		await owner.ExecuteAsync(iot.ConnectionId, EventHubOperation.Read, "events", null, (_, _) => Task.FromResult(0), default);
		await SerializedReplacement(request);
		Console.WriteLine("Event Hubs boundary checks passed");
		return 0;
	}
	static async Task SerializedReplacement(EventHubConnect request)
	{
		var factory = new Factory();
		await using var owner = new EventHubsConnectionOwner(factory, new AzureEventHubsFailureClassifier(), new AzureConfigurationFailureClassifier());
		var connection = await owner.ConnectAsync(() => request, null, default);
		var previous = factory.Last!;
		var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
		var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
		var foreground = owner.ExecuteAsync(connection.ConnectionId, EventHubOperation.Shared, null, null, async (_, _) =>
		{
			entered.SetResult();
			await release.Task;
			return 0;
		}, default);
		await entered.Task;
		bool parsed = false;
		var replacing = owner.ConnectAsync(() => { parsed = true; return request; }, null, default);
		Assert(!parsed && previous.Closes == 0 && owner.Connection == connection, "Replacement cannot parse or dispose a generation while foreground work owns it");
		release.SetResult();
		await foreground;
		var next = await replacing;
		Assert(parsed && previous.Closes == 1 && next.ConnectionId != connection.ConnectionId, "Replacement drains foreground work before publishing its generation");
	}
	sealed class Factory : IEventHubsGatewayFactory
	{
		public Gateway? Last; public bool FailProbe; public int FailGatewayClose;
		public Task<IEventHubsGateway> ConnectAsync(ConnectionProfile profile, EventHubsManagementContext? management, Func<DeviceCodeEvent, Task> prompt, CancellationToken token)
		{
			Last = new()
			{
				Prompt = prompt,
				FailProbe = FailProbe,
				FailGatewayClose = FailGatewayClose
			};
			return Task.FromResult<IEventHubsGateway>(Last);
		}
	}
	sealed class Gateway : IEventHubsGateway
	{
		public Func<DeviceCodeEvent, Task>? Prompt;
		public Action? AfterRead;
		public int OpenReaders, Closes, Sends, FailReaderClose, FailGatewayClose;
		public bool FailOpen, FailProbe, SendUnknown;
		public bool CanBrowse => false;
		public IEventHubsAdministration? Administration => null;
		public Task<EventHubInfo> GetHubAsync(string hub, CancellationToken token, bool forSending = false) => FailProbe ? Task.FromException<EventHubInfo>(new IOException("probe")) : Task.FromResult(new EventHubInfo(hub, ["0"], "2026-10-11T00:00:00Z"));
		public Task<EventHubPartition> GetPartitionAsync(string hub, string partition, CancellationToken token, bool forSending = false) => throw new NotSupportedException();
		public Task<EventHubsPage> ListAsync(string kind, string hub, string? continuation, CancellationToken token) => throw new NotSupportedException();
		public IEventHubReader OpenReader(string hub, string group, string partition, StreamPosition position)
		{
			if (FailOpen)
				throw new IOException("open");
			OpenReaders++;
			return new Reader(this);
		}
		public IEventHubSender OpenSender(string hub) => new Sender(this);
		public ValueTask DisposeAsync()
		{
			Closes++;
			return FailGatewayClose-- > 0 ? ValueTask.FromException(new IOException("gateway close")) : ValueTask.CompletedTask;
		}
		sealed class Reader(Gateway owner) : IEventHubReader
		{
			private bool closed;
			public Task<IReadOnlyList<ReceivedEvent>> ReadAsync(TimeSpan wait, CancellationToken token)
			{
				owner.AfterRead?.Invoke();
				return Task.FromResult<IReadOnlyList<ReceivedEvent>>([new MemoryEvent()]);
			}
			public ValueTask DisposeAsync()
			{
				if (owner.FailReaderClose-- > 0)
					return ValueTask.FromException(new IOException("close"));
				if (!closed)
				{
					closed = true;
					owner.OpenReaders--;
				}
				return ValueTask.CompletedTask;
			}
		}
		sealed class Sender(Gateway owner) : IEventHubSender
		{
			public Task<IEventHubBatch> CreateBatchAsync(EventRouting routing, CancellationToken token) => Task.FromResult<IEventHubBatch>(new Batch(owner));
			public ValueTask DisposeAsync() => ValueTask.CompletedTask;
		}
		sealed class Batch(Gateway owner) : IEventHubBatch
		{
			public int Count
			{
				get; private set;
			}
			public bool TryAdd(OutgoingEvent value)
			{
				Count++;
				return true;
			}
			public Task SendAsync(Action dispatch, CancellationToken token)
			{
				dispatch();
				owner.Sends++;
				return owner.SendUnknown ? Task.FromException(new IOException("ack lost")) : Task.CompletedTask;
			}
			public void Dispose()
			{
			}
		}
	}
	sealed class MemoryEvent : ReceivedEvent
	{
		public override EventBody EventBody { get; } = EventBody.FromBytes(new byte[] { 0, 255, 128 });
		public override long SequenceNumber => 9007199254740993;
		public override string OffsetString => "opaque:offset";
		public override DateTimeOffset EnqueuedTime => DateTimeOffset.UnixEpoch;
		public override string? PartitionKey => null;
		public override string? MessageId => "message";
		public override string? ContentType => "application/octet-stream";
		public override string? CorrelationId => null;
		public override IReadOnlyDictionary<string, object> Properties { get; } = new Dictionary<string, object>();
		public override IReadOnlyDictionary<string, object> SystemProperties { get; } = new Dictionary<string, object>();
	}
}
