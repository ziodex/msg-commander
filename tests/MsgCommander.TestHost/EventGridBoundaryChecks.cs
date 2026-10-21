using MsgCommander.Application.EventGrid.Administration;
using System.Text.Json;

static class EventGridBoundaryChecks
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
	static readonly EventGridTarget Target = new("subscription", "orders", "fulfillment");
	static readonly EventGridConnect Request = new(new(Id(), "Grid", "event-grid", FixtureEventGridFactory.Host, "device-code", "", "", ""),
		new(FixtureEventGridFactory.Root, "fixture", "22222222-2222-4222-8222-222222222222"));
	public static async Task<int> Run()
	{
		var factory = new Factory();
		await using var owner = new EventGridConnectionOwner(factory, new AzureEventGridFailureClassifier());
		var first = await owner.ConnectAsync(() => Request, null, default);
		var original = factory.Last!;
		EventGridConnectionContext? priorContext = null;
		var receiveId = Id();
		var publishId = Id();
		await owner.ExecuteAsync(first.ConnectionId, _ => Task.CompletedTask, async (context, token) =>
		{
			priorContext = context;
			var receive = new EventGridReceive(receiveId, first.ConnectionId, Target, 2, 2, 10, 1, true);
			var retained = await context.Pull.ReceiveAsync(receive, "receive", _ => Task.CompletedTask, token);
			Assert(retained.Confirmed == 2 && retained.Status == "completed", "Typed envelopes become connection-owned handles");
			Assert(context.Pull.Inspect(Target, retained.Handles[0]).EventJson.Contains("9007199254740993"), "Payload JSON remains exact");
			Assert(!JsonSerializer.Serialize(original.LastToken).Contains("SECRET") && original.LastToken!.ToString() == "[Event Grid lease]", "Broker leases have no serializable token property or revealing ToString");
			var reads = original.Reads;
			Assert(ReferenceEquals(await context.Pull.ReceiveAsync(receive, "receive", _ => Task.CompletedTask, token), retained) && original.Reads == reads, "Receipt replay cannot acquire more locks");
			await Reject(() => context.Pull.ReceiveAsync(receive, "changed", _ => Task.CompletedTask, token), OperationFailure.InvalidInput);
			await Reject(() => context.Pull.SettleAsync(new(Id(), first.ConnectionId, Target with { SubscriptionName = "other" }, "acknowledge", retained.Handles, 0, true), "foreign", _ => Task.CompletedTask, token), OperationFailure.InvalidInput);
			using var cancelled = new CancellationTokenSource();
			original.AfterSettlement = cancelled.Cancel;
			var settled = await context.Pull.SettleAsync(new(Id(), first.ConnectionId, Target, "acknowledge", retained.Handles, 0, true), "settle", _ => Task.CompletedTask, cancelled.Token);
			Assert(settled.Confirmed == 1 && settled.Failed == 1 && settled.Uncertain == 0 && settled.Results[1].ErrorCode == "TokenLost", "Complete per-event response wins a late cancellation");
			await Reject(() => context.Pull.SettleAsync(new(Id(), first.ConnectionId, Target, "acknowledge", retained.Handles, 0, true), "reuse", _ => Task.CompletedTask, token), OperationFailure.InvalidInput);
			original.AfterSettlement = null;
			var next = await context.Pull.ReceiveAsync(receive with
			{
				Id = Id(),
				MaxEvents = 1,
				BatchSize = 1
			}, "again", _ => Task.CompletedTask, token);
			original.LoseSettlement = true;
			var unknown = await context.Pull.SettleAsync(new(Id(), first.ConnectionId, Target, "release", next.Handles, 10, true), "lost-settlement", _ => Task.CompletedTask, token);
			Assert(unknown.Uncertain == 1 && unknown.Status == "unknown" && context.Pull.List(Target).Single(x => x.Handle == next.Handles[0]).State == "unknown", "Lost acknowledgement invalidates the held lease without automatic replay");
			var draft = new CloudEventDraft("event", "/orders", "Order.Created", "", "", "application/json", "", "json", "9007199254740993", []);
			original.LosePublish = true;
			var job = new EventGridPublish(publishId, first.ConnectionId, "orders", "single", [draft], 1, 1, 0, true);
			var published = await context.Publishing.ExecuteAsync(job, "publish", _ => Task.CompletedTask, token);
			Assert(published.Status == "unknown" && published.Uncertain == 1 && original.Publishes == 1, "Dispatched publish remains uncertain without acknowledgement");
			Assert(ReferenceEquals(await context.Publishing.ExecuteAsync(job, "publish", _ => Task.CompletedTask, token), published) && original.Publishes == 1, "Publish receipt replay never resends");
			var parent = new EventGridTarget("namespace", null, null);
			var page = await context.Browsing.ListAsync(parent, null, token);
			Assert(page.ContinuationToken is not null && page.ContinuationToken != original.Continuation, "Browse continuations are opaque");
			await Reject(() => context.Browsing.ListAsync(parent, page.ContinuationToken, token), OperationFailure.OperationBlocked);
			original.Continuation = "next-page";
			Assert((await context.Browsing.ListAsync(parent, page.ContinuationToken, token)).Items.Count == 1, "Repeated continuation failure leaves its prior cursor usable");
			return 0;
		}, default);
		var settlements = original.Settlements;
		await owner.ResetAsync(default);
		Assert(original.Closes == 1 && original.Settlements == settlements && priorContext!.Pull.List(Target).Length == 0 && priorContext.Publishing.GetResult(publishId) is null, "Disconnect clears local state without settling broker locks");
		var second = await owner.ConnectAsync(() => Request, null, default);
		await Reject(() => owner.ExecuteAsync(first.ConnectionId, null, (_, _) => Task.FromResult(0), default), OperationFailure.ConnectionExpired);
		await Reject(() => original.Prompt!(new("OLD", "later")), OperationFailure.AuthenticationRequired);
		var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
		var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
		var foreground = owner.ExecuteAsync(second.ConnectionId, null, async (_, _) => { entered.SetResult(); await release.Task; return 0; }, default);
		await entered.Task;
		bool parsed = false;
		var previous = factory.Last!;
		var replacement = owner.ConnectAsync(() => { parsed = true; return Request; }, null, default);
		Assert(!parsed && previous.Closes == 0 && owner.Connection == second, "Replacement waits for foreground work before parsing or disposal");
		release.SetResult();
		await foreground;
		await replacement;
		Assert(parsed && previous.Closes == 1, "Replacement drains the prior generation");
		using var cancellation = new CancellationTokenSource();
		factory.AfterConnect = cancellation.Cancel;
		factory.FailCloses = 2;
		try
		{
			await owner.ConnectAsync(() => Request, null, cancellation.Token);
			throw new Exception("Cancelled candidate published");
		}
		catch (OperationCanceledException) { }
		var unpublished = factory.Last!;
		factory.AfterConnect = null;
		factory.FailCloses = 0;
		Assert(owner.Connection is null && unpublished.Closes == 1, "Cancelled unpublished client stays owned through cleanup failure");
		await Reject(() => owner.ConnectAsync(() => Request, null, default), OperationFailure.OperationBlocked);
		await owner.ConnectAsync(() => Request, null, default);
		Assert(unpublished.Closes == 3, "Explicit reconnect retries the retained client before publishing");
		await AdapterLeaseScope();
		Console.WriteLine("Event Grid boundary checks passed");
		return 0;
	}
	static async Task AdapterLeaseScope()
	{
		var firstWire = new EventGridWire();
		var secondWire = new EventGridWire();
		await using var first = await FixtureEventGridFactory.Connect(firstWire, publishingCredential: new Credential());
		await using var second = await FixtureEventGridFactory.Connect(secondWire, publishingCredential: new Credential());
		var received = await first.ReceiveAsync(Target, 1, 10, () => { }, default);
		var dispatched = false;
		await Reject(() => second.SettleAsync(Target, "acknowledge", 0, [received.Events[0].Token], () => dispatched = true, default), OperationFailure.InvalidInput);
		Assert(!dispatched && secondWire.Pulls.Count == 0, "Production adapter rejects another gateway's lease before dispatch");
	}
	sealed class Credential : Azure.Core.TokenCredential
	{
		public override Azure.Core.AccessToken GetToken(Azure.Core.TokenRequestContext context, CancellationToken token) => new("fixture", DateTimeOffset.UtcNow.AddHours(1));
		public override ValueTask<Azure.Core.AccessToken> GetTokenAsync(Azure.Core.TokenRequestContext context, CancellationToken token) => ValueTask.FromResult(GetToken(context, token));
	}
	sealed class Factory : IEventGridGatewayFactory
	{
		public Gateway? Last; public Action? AfterConnect; public int FailCloses;
		public Task<IEventGridGateway> ConnectAsync(ConnectionProfile profile, EventGridManagement management, Func<DeviceCodeEvent, Task> prompt, CancellationToken token)
		{
			Last = new()
			{
				Prompt = prompt,
				FailCloses = FailCloses
			};
			AfterConnect?.Invoke();
			return Task.FromResult<IEventGridGateway>(Last);
		}
	}
	sealed class Gateway : IEventGridGateway
	{
		private readonly object issuer = new();
		public Func<DeviceCodeEvent, Task>? Prompt;
		public Action? AfterSettlement;
		public EventGridLockToken? LastToken;
		public int Reads, Settlements, Publishes, Closes, FailCloses;
		public bool LoseSettlement, LosePublish;
		public string Continuation = "opaque-broker-page";
		public string Location => "westeurope";
		public Task<EventGridReceiveBatch> ReceiveAsync(EventGridTarget target, int count, int wait, Action dispatch, CancellationToken token)
		{
			dispatch();
			Reads++;
			return Task.FromResult(new EventGridReceiveBatch(Enumerable.Range(0, count).Select(i => new EventGridDeliveryEnvelope(LastToken = new(issuer, "SECRET-" + Reads + "-" + i), 1, "{\"specversion\":\"1.0\",\"id\":\"event\",\"source\":\"/orders\",\"type\":\"created\",\"data\":9007199254740993}")).ToArray()));
		}
		public Task<EventGridSettlementBatch> SettleAsync(EventGridTarget target, string action, int delay, IReadOnlyList<EventGridLockToken> tokens, Action dispatch, CancellationToken token)
		{
			dispatch();
			Settlements++;
			if (LoseSettlement)
				throw new IOException("acknowledgement lost");
			AfterSettlement?.Invoke();
			return Task.FromResult(new EventGridSettlementBatch([tokens[0]], tokens.Skip(1).Select(t => new EventGridTokenFailure(t, EventGridSettlementFailureCode.TokenLost)).ToArray()));
		}
		public Task PublishAsync(string topic, string mode, byte[] body, Action dispatch, CancellationToken token)
		{
			dispatch();
			Publishes++;
			return LosePublish ? Task.FromException(new IOException("acknowledgement lost")) : Task.CompletedTask;
		}
		public Task<EventGridAdminDetails> AdminGetAsync(EventGridTarget target, CancellationToken token) => Task.FromResult(new EventGridAdminDetails(target, new string('A', 64), null, new("Queue", 60, 10, "P1D", null, null, []), null));
		public Task<string> ChangeAsync(EventGridCommand change, Action dispatch, CancellationToken token) => throw new NotSupportedException();
		public Task<EventGridPage> ListAsync(EventGridTarget parent, string? continuation, CancellationToken token) => Task.FromResult(new EventGridPage([new(new("topic", "orders", null), "orders", "Succeeded", null, "CloudEventSchemaV1_0")], Continuation));
		public Task<EventGridDetails> GetAsync(EventGridTarget target, CancellationToken token) => throw new NotSupportedException();
		public ValueTask DisposeAsync()
		{
			Closes++;
			return FailCloses-- > 0 ? ValueTask.FromException(new IOException("close")) : ValueTask.CompletedTask;
		}
	}
}
