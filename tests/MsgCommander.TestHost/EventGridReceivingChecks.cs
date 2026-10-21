using MsgCommander.Host;
using Azure.Core;
using System.Net;
using System.Text.Json;
static class EventGridReceivingChecks
{
	private static int count;
	private static void Assert(bool condition, string label)
	{
		if (!condition)
			throw new Exception(label);
		count++;
	}
	private static async Task Reject(Func<Task> action)
	{
		try
		{
			await action();
		}
		catch (OperationException) { count++; return; }
		throw new Exception("Expected validation rejection");
	}
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	private static readonly EventGridTarget Target = new("subscription", "orders", "fulfillment");
	private sealed class Ready(IEventGridGateway gateway) : IEventGridGatewayFactory
	{
		public Task<IEventGridGateway> ConnectAsync(ConnectionProfile p, EventGridManagement m, Func<DeviceCodeEvent, Task> code, CancellationToken cancellation) => Task.FromResult(gateway);
	}
	private sealed class Clock : TimeProvider
	{
		public DateTimeOffset Now = DateTimeOffset.UtcNow; public override DateTimeOffset GetUtcNow() => Now;
	}
	private sealed class Credential : TokenCredential
	{
		public string[] Scopes = []; public bool Cancel; public override AccessToken GetToken(TokenRequestContext context, CancellationToken token)
		{
			Scopes = context.Scopes;
			if (Cancel)
				throw new OperationCanceledException(token);
			return new("SECRET-DATA", DateTimeOffset.UtcNow.AddHours(1));
		}
		public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext context, CancellationToken token) => ValueTask.FromResult(GetToken(context, token));
	}
	private static HttpResponseMessage Reply(string body, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(body) };
	public static async Task<int> Run()
	{
		var wire = new EventGridWire();
		var credential = new Credential();
		var gateway = await FixtureEventGridFactory.Connect(wire, publishingCredential: credential);
		var clock = new Clock();
		await using var workspace = new EventGridWorkspace(new Ready(gateway), clock);
		var connection = (EventGridConnection)(await workspace.ExecuteAsync("eg.connect", JsonSerializer.SerializeToElement(new
		{
			operationId = Guid.NewGuid().ToString(),
			profile = new
			{
				id = Guid.NewGuid().ToString(),
				service = "event-grid",
				@namespace = FixtureEventGridFactory.Host,
				auth = "device-code"
			},
			management = new EventGridManagement(FixtureEventGridFactory.Root, "fixture", Guid.NewGuid().ToString())
		}, Json), _ => Task.CompletedTask, default))!;
		EventGridReceive Request() => new(Guid.NewGuid().ToString(), connection.ConnectionId, Target, 3, 2, 10, 60, true);
		Task<object?> Execute(string method, object p, CancellationToken token = default, Func<object, Task>? emit = null) => workspace.ExecuteAsync(method, JsonSerializer.SerializeToElement(p, Json), emit ?? (_ => Task.CompletedTask), token);
		async Task<EventGridPullOutcome> Receive(EventGridReceive p, CancellationToken token = default, Func<object, Task>? emit = null) => (EventGridPullOutcome)(await Execute("eg.pull.receive", p, token, emit))!;
		object Read() => new
		{
			id = Guid.NewGuid().ToString(),
			connectionId = connection.ConnectionId,
			target = Target
		};
		async Task<EventGridReceived[]> Items() => (EventGridReceived[])(await Execute("eg.pull.list", Read()))!;
		EventGridSettle SettleRequest(string action, IReadOnlyList<string> handles) => new(Guid.NewGuid().ToString(), connection.ConnectionId, Target, action, handles, 0, true);
		async Task<EventGridPullOutcome> Settle(EventGridSettle p, CancellationToken token = default) => (EventGridPullOutcome)(await Execute("eg.pull.settle", p, token))!;
		var progress = new List<EventGridPullProgress>();
		var p = Request();
		var result = await Receive(p, emit: e => { progress.Add((EventGridPullProgress)e); return Task.CompletedTask; });
		Assert(result.Status == "completed" && result.Confirmed == 3 && wire.Pulls.Count == 2, "Receive count and batch bounds");
		Assert(wire.Requests[^1].AbsoluteUri == "https://" + FixtureEventGridFactory.Host + "/topics/orders/eventsubscriptions/fulfillment:receive?api-version=2024-06-01&maxEvents=1&maxWaitTime=10", "Stable scoped receive URI");
		Assert(credential.Scopes.SequenceEqual(["https://eventgrid.azure.net/.default"]), "Data-plane Entra audience");
		Assert(progress[^1].Phase == "finished" && progress[^1].Confirmed == 3, "Final progress matches retained receipt");
		var items = await Items();
		Assert(items.Length == 3 && items.All(v => v.State == "held" && v.DeliveryCount == 1), "Opaque held events retained");
		Assert(!JsonSerializer.Serialize(result, Json).Contains("SECRET") && !JsonSerializer.Serialize(items, Json).Contains("SECRET"), "Broker tokens absent from renderer results");
		var inspect = (EventGridEventInspection)(await Execute("eg.pull.inspect", new
		{
			id = Guid.NewGuid().ToString(),
			connectionId = connection.ConnectionId,
			target = Target,
			handle = items[0].Handle
		}))!;
		Assert(inspect.EventJson.Contains("9007199254740993") && !inspect.Truncated && !inspect.EventJson.Contains("SECRET-LOCK"), "Exact event JSON inspection without token");
		var calls = wire.Pulls.Count;
		Assert(await Receive(p) == result && wire.Pulls.Count == calls, "Receive request replay never receives twice");
		await Reject(() => Receive(p with { MaxEvents = 4 }));
		await Reject(() => Receive(Request() with { Acknowledged = false }));
		await Reject(() => Receive(Request() with { BatchSize = 11 }));
		await Reject(() => Receive(Request() with { MaxWaitSeconds = 1 }));
		await Reject(() => Receive(Request() with { MaxSeconds = 301 }));
		var push = await Receive(Request() with
		{
			Target = new("subscription", "orders", "audit")
		});
		Assert(push.Status == "failed" && push.Uncertain == 0 && wire.Pulls.Count == calls, "Fresh Queue-only preflight blocks Push without a POST");
		await Reject(() => Execute("eg.pull.inspect", new { id = Guid.NewGuid().ToString(), connectionId = connection.ConnectionId, target = new EventGridTarget("subscription", "orders", "audit"), handle = items[0].Handle }));
		foreach (var action in new[] { "renewLock", "acknowledge", "release", "reject" })
		{
			if (action == "renewLock")
				clock.Now = clock.Now.AddSeconds(15);
			var index = action == "reject" ? 2 : action == "release" ? 1 : 0;
			var settle = SettleRequest(action, [items[index].Handle]) with
			{
				ReleaseDelaySeconds = action == "release" ? 600 : 0
			};
			wire.PullOverride = (request, _) => { Assert(request.Headers.Authorization?.Parameter == "SECRET-DATA" && request.Content!.Headers.ContentType!.MediaType == "application/json", "Backend authorization and content type"); return Task.FromResult(Reply("{\"succeededLockTokens\":[\"SECRET-LOCK-" + (index + 1) + "\"],\"failedLockTokens\":[]}")); };
			result = await Settle(settle);
			Assert(result.Confirmed == 1 && result.Status == "completed", "Confirmed " + action);
			Assert(wire.Requests[^1].AbsolutePath.EndsWith(":" + action) && (action != "release" || wire.Requests[^1].Query.EndsWith("releaseDelayInSeconds=600")), "Exact settlement route " + action);
			var before = wire.Pulls.Count;
			Assert(await Settle(settle) == result && wire.Pulls.Count == before, "Settlement replay never dispatches twice");
			if (action == "renewLock")
				Assert(DateTimeOffset.Parse((await Items())[0].EstimatedLockedUntil) > DateTimeOffset.Parse(items[0].EstimatedLockedUntil), "Renewed estimate advances");
		}
		await Reject(() => Settle(SettleRequest("acknowledge", [items[0].Handle])));
		await Execute("eg.pull.clear", Read());
		Assert((await Items()).Length == 0, "Finished snapshots cleared locally");
		wire.PullOverride = null;
		var received = await Receive(Request() with
		{
			MaxEvents = 2
		});
		wire.PullMode = "settle-partial";
		result = await Settle(SettleRequest("acknowledge", received.Handles));
		Assert(result.Confirmed == 1 && result.Failed == 1 && result.Status == "failed" && result.Results[0].ErrorCode == "TokenLost", "Per-token partial settlement");
		Assert((await Items()).Any(v => v.State == "lock-lost") && !JsonSerializer.Serialize(result, Json).Contains("SECRET"), "Lock loss and error sanitation");
		wire.PullMode = "fixture";
		received = await Receive(Request() with
		{
			MaxEvents = 2
		});
		wire.PullOverride = (_, _) => throw new HttpRequestException("SECRET lost settlement");
		result = await Settle(SettleRequest("release", received.Handles));
		Assert(result.Status == "unknown" && result.Uncertain == 2 && result.Confirmed == 0, "Lost settlement receipt never assumes success");
		await Reject(() => Settle(SettleRequest("release", received.Handles)));
		wire.PullOverride = null;
		received = await Receive(Request() with
		{
			MaxEvents = 1
		});
		wire.PullOverride = (_, _) => Task.FromResult(Reply("{\"succeededLockTokens\":[],\"failedLockTokens\":[]}"));
		result = await Settle(SettleRequest("reject", received.Handles));
		Assert(result.Uncertain == 1 && result.Status == "unknown", "Missing per-token result uncertain");
		wire.PullOverride = null;
		received = await Receive(Request() with
		{
			MaxEvents = 1
		});
		wire.PullOverride = (_, _) => Task.FromResult(Reply("{\"succeededLockTokens\":[\"foreign\"],\"failedLockTokens\":[]}"));
		result = await Settle(SettleRequest("acknowledge", received.Handles));
		Assert(result.Uncertain == 1, "Foreign token result cannot confirm settlement");
		wire.PullOverride = null;
		received = await Receive(Request() with
		{
			MaxEvents = 1
		});
		clock.Now = clock.Now.AddMinutes(2);
		Assert((await Items()).Single(v => v.Handle == received.Handles[0]).State == "expired", "Expired estimates refuse stale settlement");
		await Reject(() => Settle(SettleRequest("renewLock", received.Handles)));
		wire.PullMode = "pull-large";
		received = await Receive(Request() with
		{
			MaxEvents = 1
		});
		inspect = (EventGridEventInspection)(await Execute("eg.pull.inspect", new
		{
			id = Guid.NewGuid().ToString(),
			connectionId = connection.ConnectionId,
			target = Target,
			handle = received.Handles[0]
		}))!;
		Assert(inspect.Truncated && inspect.EventJson.Length == 65536 && inspect.Item.Bytes > 80000, "Large event bounded inspection");
		wire.PullMode = "pull-empty";
		result = await Receive(Request());
		Assert(result.Status == "limited" && result.Reason == "empty" && result.Confirmed == 0, "Empty receive ends bounded job");
		wire.PullMode = "pull-lost";
		p = Request();
		result = await Receive(p);
		Assert(result.Status == "unknown" && result.Uncertain == 2 && !result.Summary.Contains("SECRET"), "Lost receive may hold undisclosed locks");
		Assert(Equals(await Execute("eg.pull.result", new
		{
			id = Guid.NewGuid().ToString(),
			connectionId = connection.ConnectionId,
			operationId = p.Id
		}), result), "Read-only recovery returns immutable receipt");
		wire.PullMode = "pull-denied";
		result = await Receive(Request());
		Assert(result.Status == "failed" && result.Uncertain == 0 && result.Summary.Contains("data access"), "Known data access denial");
		wire.PullMode = "fixture";
		calls = 0;
		wire.PullOverride = (_, _) => { calls++; if (calls == 2) throw new HttpRequestException("lost"); return Task.FromResult(Reply("{\"value\":[{\"brokerProperties\":{\"lockToken\":\"SECRET-first\",\"deliveryCount\":1},\"event\":{\"specversion\":\"1.0\",\"id\":\"first\",\"source\":\"/test\",\"type\":\"Test\"}}]}")); };
		result = await Receive(Request() with
		{
			BatchSize = 1
		});
		Assert(result.Confirmed == 1 && result.Uncertain == 1 && calls == 2, "Earlier receives survive a lost later batch");
		wire.PullOverride = null;
		using var between = new CancellationTokenSource();
		result = await Receive(Request() with
		{
			BatchSize = 1
		}, between.Token, e => { if (e is EventGridPullProgress { Phase: "receiving", Confirmed: 1 }) between.Cancel(); return Task.CompletedTask; });
		Assert(result.Confirmed == 1 && result.Uncertain == 0 && result.Status == "cancelled", "Cancellation between requests retains known handles");
		using var cancel = new CancellationTokenSource();
		wire.PullOverride = async (_, token) => { cancel.Cancel(); await Task.Delay(10000, token); return Reply("{}"); };
		result = await Receive(Request(), cancel.Token);
		Assert(result.Uncertain == 2 && result.Reason == "cancelled", "In-flight cancellation classifies possible locks");
		wire.PullOverride = async (_, token) => { await Task.Delay(10000, token); return Reply("{}"); };
		result = await Receive(Request() with
		{
			MaxSeconds = 1
		});
		Assert(result.Uncertain == 2 && result.Reason == "time", "Independent time bound cancels receive");
		wire.PullOverride = (_, _) => Task.FromResult(Reply("{\"value\":[],\"value\":[]}"));
		result = await Receive(Request());
		Assert(result.Uncertain == 2, "Duplicate JSON response rejected without retry");
		credential.Cancel = true;
		var beforeAuth = wire.Pulls.Count;
		result = await Receive(Request());
		Assert(result.Uncertain == 0 && wire.Pulls.Count == beforeAuth, "Authentication fails before dispatch");
		credential.Cancel = false;
		wire.PullOverride = null;
		wire.PullMode = "fixture";
		received = await Receive(Request() with
		{
			MaxEvents = 1
		});
		for (var renewal = 0; renewal < 61; renewal++)
		{
			clock.Now = clock.Now.AddSeconds(59);
			result = await Settle(SettleRequest("renewLock", received.Handles));
			if (result.Confirmed != 1)
				throw new Exception("Renewal chain lost its lock");
		}
		clock.Now = clock.Now.AddSeconds(2);
		Assert((await Items()).Single(v => v.Handle == received.Handles[0]).State == "held", "A final renewal can extend the effective lock beyond one hour");
		await Reject(() => Settle(SettleRequest("renewLock", received.Handles)));
		clock.Now = clock.Now.AddMinutes(10);
		await Execute("eg.pull.clear", Read());
		var largeIndex = 0;
		wire.PullOverride = (_, _) => { var rows = Enumerable.Range(0, 10).Select(_ => new { brokerProperties = new { lockToken = "SECRET-wide-" + (++largeIndex), deliveryCount = 1 }, @event = new { specversion = "1.0", id = new string('界', 300) + largeIndex, source = new string('界', 300), type = new string('界', 300), subject = new string('界', 300) } }); return Task.FromResult(Reply(JsonSerializer.Serialize(new { value = rows }, Json))); };
		result = await Receive(Request() with
		{
			MaxEvents = 100,
			BatchSize = 10
		});
		items = await Items();
		Assert(result.Confirmed == 100 && items.All(v => v.EventId.Length <= 257) && JsonSerializer.SerializeToUtf8Bytes(items, Json).Length < 786432, "Worst-case escaped metadata stays below IPC frame limit");
		await Execute("eg.reset", new
		{
		});
		await Reject(() => Execute("eg.pull.list", Read()));
		Console.WriteLine($"Event Grid receiving adapter checks passed ({count} assertions)");
		return 0;
	}
}
