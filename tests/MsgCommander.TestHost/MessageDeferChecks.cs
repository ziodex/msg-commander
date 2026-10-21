using System.Text.Json;
using Azure.Messaging.ServiceBus;
using MsgCommander.Host;

static class MessageDeferChecks
{
	static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };
	static void Assert(bool value, string label)
	{
		if (!value)
			throw new Exception(label);
	}
	static JsonElement Input(object value) => JsonSerializer.SerializeToElement(value, Json);
	static string Id() => Guid.NewGuid().ToString();
	public static async Task<int> Run()
	{
		var target = new EntityTarget("queue", "orders");
		var scope = new DeferredMessageScope(Id(), "fixture.servicebus.windows.net", target, "active", "");
		var memory = new InMemoryMessageDeferProvider(2);
		memory.Remember(scope, new(9007199254740993, DateTimeOffset.UtcNow));
		memory.Remember(scope, new(long.MaxValue, DateTimeOffset.UtcNow));
		memory.Remember(scope, new(9007199254740993, DateTimeOffset.UtcNow));
		Assert(memory.List(scope).Select(x => x.Sequence).SequenceEqual(new[] { 9007199254740993L, long.MaxValue }), "FIFO ordering, exact Int64 and deduplication");
		foreach (var other in new[] { scope with { ProfileId = Id() }, scope with { Namespace = "other.servicebus.windows.net" }, scope with { Target = new("queue", "Orders") }, scope with { SubQueue = "dead-letter" }, scope with { SessionId = "session-001" } })
			Assert(memory.List(other).Count == 0, "Profile/namespace/case-sensitive target/subqueue/session isolation");
		try
		{
			memory.Remember(scope, new(3, DateTimeOffset.UtcNow));
			throw new Exception("Capacity accepted");
		}
		catch (InvalidOperationException) { }
		Assert(memory.List(scope).Count == 2 && memory.Forget(scope, long.MaxValue) && !memory.Forget(scope, long.MaxValue), "Capacity preserves existing references; exact acknowledgement");
		var parallel = new InMemoryMessageDeferProvider();
		Parallel.For(0, 1000, i => parallel.Remember(scope, new(i, DateTimeOffset.UtcNow)));
		Assert(parallel.List(scope).Count == 1000, "Concurrent provider writes");

		var provider = new TestProvider();
		var factory = new FixtureFactory();
		await using var workspace = new ServiceBusWorkspace(factory, provider);
		var profileId = Id();
		var connectionId = "";
		async Task<object?> Call(string method, object value) => await workspace.ExecuteAsync(method, Input(value), _ => Task.CompletedTask, default);
		async Task Connect() => connectionId = ((NamespaceConnection)(await Call("sb.connect", new
		{
			operationId = Id(),
			profile = new
			{
				id = profileId,
				name = "Defer checks",
				service = "service-bus",
				@namespace = "recovery.fixture.servicebus.windows.net",
				auth = "sas",
				tenantId = "",
				clientId = "",
				secret = "fixture-only",
				rememberSecret = false
			}
		}))!).ConnectionId;
		async Task<Deliveries> Receive(string? sequence = null, EntityTarget? from = null) => (Deliveries)(await Call("sb.receive", new
		{
			id = Id(),
			connectionId,
			target = from ?? target,
			subQueue = "active",
			sessionId = "",
			maxMessages = 1,
			waitSeconds = 1,
			deferredSequence = sequence
		}))!;
		async Task<OperationOutcome> Defer(string deliveryId) => (OperationOutcome)(await Call("sb.settle", new
		{
			id = Id(),
			connectionId,
			deliveryId,
			action = "defer",
			reason = "",
			description = ""
		}))!;
		async Task<DeferredReferences> List(EntityTarget? from = null) => (DeferredReferences)(await Call("sb.defer.list", new
		{
			id = Id(),
			connectionId,
			target = from ?? target,
			subQueue = "active",
			sessionId = ""
		}))!;
		await Connect();
		var held = await Receive();
		var sequence = held.Items[0].Summary.SequenceNumber;
		var result = await Defer(held.Items[0].DeliveryId);
		Assert(result.Status == "confirmed" && result.SequenceNumbers!.Single() == sequence && (await List()).Items.Single().SequenceNumber == sequence, "Confirmed defer captured by injected provider");
		Assert((await List()).Total == 1 && provider.Remembered == 1, "Read without dequeue");
		await Call("sb.reset", new
		{
		});
		await Connect();
		Assert((await List()).Total == 1, "Provider survives reset and reconnect");
		try
		{
			await Receive("1");
			throw new Exception("Missing deferred message accepted");
		}
		catch (ServiceBusException) { }
		Assert((await List()).Total == 1, "Failed retrieval preserves reference");
		held = await Receive(sequence);
		Assert(held.Items.Single().Summary.SequenceNumber == sequence && (await List()).Total == 0 && provider.Forgotten == 1, "Confirmed retrieval acknowledges exact reference");
		await Defer(held.Items.Single().DeliveryId);
		await Call("sb.defer.forget", new
		{
			id = Id(),
			connectionId,
			target,
			subQueue = "active",
			sessionId = "",
			sequenceNumber = sequence
		});
		held = await Receive(sequence);
		Assert(held.Items.Count == 1, "Forgetting local metadata does not delete broker message");
		provider.FailRemember = true;
		result = await Defer(held.Items.Single().DeliveryId);
		Assert(result.Status == "confirmed" && result.Summary.Contains("could not be recorded") && result.SequenceNumbers!.Single() == sequence, "Provider failure preserves confirmed broker outcome and exact recovery sequence");
		provider.FailRemember = false;
		held = await Receive(sequence);
		await Defer(held.Items.Single().DeliveryId);
		provider.FailForget = true;
		held = await Receive(sequence);
		Assert(held.Items.Single().State == "active" && held.Warning!.Contains("could not be removed") && (await List()).Total == 1, "Acknowledgement failure retains held delivery and recoverable reference");
		provider.FailForget = false;
		await Call("sb.close-receiver", new
		{
			id = Id(),
			connectionId
		});

		var unknownTarget = new EntityTarget("queue", "empty");
		var draft = new MessageDraft("", "unknown-complete", "", "", "", "", "", "", "", "", null, []);
		await Call("sb.send", new
		{
			id = Id(),
			connectionId,
			target = unknownTarget,
			draft
		});
		held = await Receive(from: unknownTarget);
		result = await Defer(held.Items.Single().DeliveryId);
		Assert(result.Status == "unknown" && (await List(unknownTarget)).Total == 0, "Uncertain defer is not recorded as confirmed");
		await Call("sb.close-receiver", new
		{
			id = Id(),
			connectionId
		});
		provider.FailRemember = true;
		foreach (var mode in new[] { "single", "next-available" })
		{
			var listenerTarget = new EntityTarget("queue", mode == "single" ? "empty" : "session-test-provider-failure");
			await Call("sb.send", new
			{
				id = Id(),
				connectionId,
				target = listenerTarget,
				draft = draft with
				{
					MessageId = "provider-warning",
					SessionId = mode == "single" ? "" : "provider-session"
				}
			});
			var listenerId = Id();
			var state = (ListenerState)(await Call("sb.listener.start", new
			{
				id = listenerId,
				connectionId,
				target = listenerTarget,
				sessionId = "",
				sessionMode = mode,
				mode = "manual",
				maxMessages = 1,
				maxSeconds = 10,
				maxLockSeconds = 10,
				maxConcurrentSessions = mode == "single" ? 1 : 2,
				sessionIdleSeconds = 1
			}))!;
			for (var attempt = 0; attempt < 100 && !state.Items.Any(item => item.State == "active"); attempt++)
			{
				await Task.Delay(20);
				state = (ListenerState)(await Call("sb.listener.status", new
				{
					id = Id(),
					connectionId
				}))!;
			}
			var deliveryId = state.Items.Single(item => item.State == "active").DeliveryId;
			await Call("sb.listener.settle", new
			{
				id = Id(),
				connectionId,
				listenerId,
				deliveryId,
				action = "defer",
				reason = "",
				description = ""
			});
			state = (ListenerState)(await Call("sb.listener.stop", new
			{
				id = Id(),
				connectionId,
				listenerId
			}))!;
			Assert(state.Deferred == 1 && state.Failed == 0 && state.Summary.Contains("could not be recorded") && !state.Summary.Contains("SECRET"), "Listener provider warning survives stop without changing acknowledged settlement");
		}
		var jobTarget = new EntityTarget("queue", "test-provider-warning");
		await Call("sb.send", new
		{
			id = Id(),
			connectionId,
			target = jobTarget,
			draft = draft with
			{
				MessageId = "job-provider-warning"
			}
		});
		var job = (TestJobResult)(await Call("sb.test.run", new
		{
			id = Id(),
			connectionId,
			target = jobTarget,
			mode = "receive",
			maxMessages = 2,
			maxSeconds = 5,
			delayMs = 0,
			workers = 1,
			batchSize = 1,
			body = "",
			contentType = "",
			sessionId = "",
			settlement = "defer",
			acknowledged = true
		}))!;
		Assert(job.Status == "failed" && job.Deferred == 1 && job.Settled == 1 && job.Uncertain == 0 && job.DeferredSequenceNumbers.Count == 1 && job.ReferenceWarning is not null,
			"A confirmed test-job deferral survives provider failure with its exact manual retrieval receipt");
		Assert(!JsonSerializer.Serialize(job).Contains("SECRET"), "Test-job provider failure is redacted");
		provider.FailList = true;
		try
		{
			await List();
			throw new Exception("Provider read failure accepted");
		}
		catch (OperationException error) { Assert(error.Message.Contains("could not be read") && !error.Message.Contains("SECRET"), "Provider protocol errors are redacted"); }
		Console.WriteLine("Message defer checks passed: FIFO, precision, scopes, capacity, concurrency, custom provider, lifecycle, retrieval, local forget and failure recovery");
		return 0;
	}
	sealed class TestProvider : IMessageDeferProvider
	{
		readonly InMemoryMessageDeferProvider memory = new();
		public int Remembered, Forgotten;
		public bool FailRemember, FailForget, FailList;
		public void Remember(DeferredMessageScope scope, DeferredMessageReference reference)
		{
			if (FailRemember)
				throw new IOException("SECRET provider failure");
			Remembered++;
			memory.Remember(scope, reference);
		}
		public IReadOnlyList<DeferredMessageReference> List(DeferredMessageScope scope) => FailList ? throw new OperationException(OperationFailure.OperationBlocked, "SECRET provider read failure") : memory.List(scope);
		public bool Forget(DeferredMessageScope scope, long sequence)
		{
			if (FailForget)
				throw new IOException("SECRET provider failure");
			Forgotten++;
			return memory.Forget(scope, sequence);
		}
	}
}
