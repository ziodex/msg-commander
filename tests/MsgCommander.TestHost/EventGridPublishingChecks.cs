using MsgCommander.Host;
using Azure.Core;
using System.Net;
using System.Text;
using System.Text.Json;
static class EventGridPublishingChecks
{
	private static int count;
	private static void Assert(bool value, string label)
	{
		if (!value)
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
	private static CloudEventDraft Draft(string id = "event-1") => new(id, "/orders", "Order.Created", "orders/1", "2026-10-11T10:00:00.1234567+02:00", "application/json", "https://schemas.invalid/order", "json", "{\"large\":9007199254740993,\"precise\":0.1234567890123456789}", [new("enabled", "boolean", "true"), new("attempt", "integer", "-2147483648"), new("traceparent", "string", "example")]);
	private sealed class Ready(IEventGridGateway gateway) : IEventGridGatewayFactory
	{
		public Task<IEventGridGateway> ConnectAsync(ConnectionProfile p, EventGridManagement m, Func<DeviceCodeEvent, Task> code, CancellationToken token) => Task.FromResult(gateway);
	}
	private sealed class Credential : TokenCredential
	{
		public string[] Scopes = []; public bool Cancel; public int Calls;
		public override AccessToken GetToken(TokenRequestContext context, CancellationToken token)
		{
			Scopes = context.Scopes;
			Calls++;
			if (Cancel)
				throw new OperationCanceledException(token);
			return new("SECRET-DATA-TOKEN", DateTimeOffset.UtcNow.AddHours(1));
		}
		public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext context, CancellationToken token) => ValueTask.FromResult(GetToken(context, token));
	}
	public static async Task<int> Run()
	{
		var wire = new EventGridWire();
		var credential = new Credential();
		await using var gateway = await FixtureEventGridFactory.Connect(wire, publishingCredential: credential);
		var bytes = OutgoingCloudEvents.Build(Draft());
		var raw = Encoding.UTF8.GetString(bytes);
		Assert(raw.Contains("9007199254740993") && raw.Contains("0.1234567890123456789"), "JSON numeric source preserved");
		using (var doc = JsonDocument.Parse(bytes))
		{
			Assert(doc.RootElement.GetProperty("specversion").GetString() == "1.0", "Required specification version");
			Assert(doc.RootElement.GetProperty("enabled").GetBoolean() && doc.RootElement.GetProperty("attempt").GetInt32() == int.MinValue, "Typed extension attributes");
		}
		var dispatch = 0;
		await gateway.PublishAsync("orders", "single", bytes, () => dispatch++, default);
		Assert(dispatch == 1 && credential.Scopes.SequenceEqual(["https://eventgrid.azure.net/.default"]), "Dedicated data-plane audience");
		Assert(wire.Requests[^1].AbsoluteUri == "https://" + FixtureEventGridFactory.Host + "/topics/orders:publish?api-version=2024-06-01", "Exact verified host, topic and stable single route");
		Assert(wire.Publishes[^1].ContentType == "application/cloudevents+json; charset=utf-8" && wire.Publishes[^1].Body == raw, "Structured single encoding");
		await gateway.PublishAsync("orders", "batch", OutgoingCloudEvents.Batch([bytes, bytes]), () => dispatch++, default);
		Assert(wire.Requests[^1].Query == "?_overload=publishCloudEvents&api-version=2024-06-01" && wire.Publishes[^1].ContentType == "application/cloudevents-batch+json; charset=utf-8" && JsonDocument.Parse(wire.Publishes[^1].Body).RootElement.GetArrayLength() == 2, "Batch array encoding and overload");
		wire.PublishOverride = (request, _) => { Assert(request.Headers.Authorization?.Scheme == "Bearer" && request.Headers.Authorization.Parameter == "SECRET-DATA-TOKEN", "Token stays in backend authorization header"); return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("malformed SECRET provider body") }); };
		await gateway.PublishAsync("orders", "single", bytes, () => { }, default);
		count++;
		wire.PublishOverride = null;
		foreach (var d in new[] { Draft() with { DataContentType = "invalid" }, Draft() with { DataContentType = "application/xml" }, Draft() with { Id = "" }, Draft() with { Source = "bad source" }, Draft() with { DataSchema = "relative" }, Draft() with { Time = "not-time" }, Draft() with { Time = "2026-02-30T10:00:00Z" }, Draft() with { Data = "{\"a\":1,\"a\":2}" }, Draft() with { Data = "[1,]" }, Draft() with { Data = new string('[', 33) + "0" + new string(']', 33) }, Draft() with { DataMode = "base64", Data = "bad!" }, Draft() with { DataMode = "none", Data = "present" }, Draft() with { Properties = [new("id", "string", "override")] }, Draft() with { Properties = [new("Upper", "string", "x")] }, Draft() with { Properties = [new("x", "integer", "2147483648")] }, Draft() with { Properties = [new("x", "boolean", "True")] }, Draft() with { Properties = [new("x", "string", "a"), new("x", "string", "b")] }, Draft() with { Id = "\ud800" } })
			await Reject(() => Task.FromResult(OutgoingCloudEvents.Build(d)));
		foreach (var mode in new[] { "text", "base64", "none" })
		{
			var payload = mode == "none" ? "" : mode == "base64" ? "AAEC" : "<script>\ntext";
			var data = Encoding.UTF8.GetString(OutgoingCloudEvents.Build(Draft() with
			{
				DataMode = mode,
				Data = payload
			}));
			Assert(mode == "none" ? !data.Contains("\"data\":") : JsonDocument.Parse(data).RootElement.GetProperty(mode == "base64" ? "data_base64" : "data").GetString() == payload, "Payload mode " + mode);
		}
		await using var workspace = new EventGridWorkspace(new Ready(gateway));
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
		EventGridPublish Request() => new(Guid.NewGuid().ToString(), connection.ConnectionId, "orders", "batch", [Draft("one"), Draft("two"), Draft("three")], 2, 60, 0, true);
		var progress = new List<EventGridPublishProgress>();
		async Task<EventGridPublishOutcome> Publish(EventGridPublish p, CancellationToken token = default, Func<object, Task>? emit = null) => (EventGridPublishOutcome)(await workspace.ExecuteAsync("eg.publish", JsonSerializer.SerializeToElement(p, Json), emit ?? (e => { progress.Add((EventGridPublishProgress)e); return Task.CompletedTask; }), token))!;
		var p = Request();
		var result = await Publish(p);
		Assert(result.Confirmed == 3 && result.ConfirmedBatches == 2 && result.Status == "completed", "Sequential batch counts");
		Assert(progress[^1].Phase == "finished" && progress[^1].Confirmed == 3, "Final progress matches receipt");
		var writes = wire.Publishes.Count;
		Assert(await Publish(p) == result && wire.Publishes.Count == writes, "Exact request replay returns immutable receipt without another POST");
		await Reject(() => Publish(p with { Drafts = [Draft("different")] }));
		await Reject(() => Publish(Request() with { Drafts = [Draft("one"), Draft("invalid") with { Data = "{" }] }));
		Assert(wire.Publishes.Count == writes, "All drafts preflight before first dispatch");
		await Reject(() => Publish(Request() with { Drafts = [Draft(), Draft()] }));
		await Reject(() => Publish(Request() with { TopicName = "../escape" }));
		await Reject(() => Publish(Request() with { Acknowledged = false }));
		wire.PublishOverride = (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("SECRET") });
		result = await Publish(Request());
		Assert(result.Status == "failed" && result.Confirmed == 0 && result.Uncertain == 0 && !result.Summary.Contains("SECRET"), "Explicit rejection sanitized");
		var calls = 0;
		wire.PublishOverride = (_, _) => { if (++calls == 2) throw new HttpRequestException("SECRET response lost"); return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)); };
		p = Request() with
		{
			BatchSize = 1
		};
		result = await Publish(p);
		Assert(result.Status == "unknown" && result.Confirmed == 1 && result.Uncertain == 1 && result.LastBatchFirstIndex == 2 && calls == 2, "Lost second acknowledgment stops without retry, preserves earlier confirmations");
		var recovered = await workspace.ExecuteAsync("eg.publish.result", JsonSerializer.SerializeToElement(new
		{
			id = Guid.NewGuid().ToString(),
			connectionId = connection.ConnectionId,
			operationId = p.Id
		}, Json), _ => Task.CompletedTask, default);
		Assert(Equals(result, recovered), "Read-only recovery");
		using var cancel = new CancellationTokenSource();
		wire.PublishOverride = async (_, token) => { cancel.Cancel(); await Task.Delay(10000, token); return new(HttpStatusCode.OK); };
		result = await Publish(Request(), cancel.Token);
		Assert(result.Status == "unknown" && result.Uncertain == 2 && result.Reason == "cancelled", "Cancellation after dispatch uncertain");
		using var pacing = new CancellationTokenSource();
		wire.PublishOverride = (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
		result = await Publish(Request() with
		{
			BatchSize = 1,
			DelayMs = 1000
		}, pacing.Token, e => { if (e is EventGridPublishProgress { Phase: "pacing" }) pacing.Cancel(); return Task.CompletedTask; });
		Assert(result.Status == "cancelled" && result.Confirmed == 1 && result.Uncertain == 0, "Pacing cancellation preserves confirmed count");
		result = await Publish(Request() with
		{
			BatchSize = 1,
			MaxSeconds = 1,
			DelayMs = 1000
		});
		Assert(result.Status == "limited" && result.Confirmed == 1 && result.Uncertain == 0 && result.Reason == "time", "Bounded time stops before another POST");
		using var late = new CancellationTokenSource();
		wire.PublishOverride = (_, _) => { late.Cancel(); return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)); };
		result = await Publish(Request() with
		{
			Drafts = [Draft()],
			Mode = "single"
		}, late.Token);
		Assert(result.Status == "completed" && result.Confirmed == 1, "Acknowledgment survives late cancellation");
		wire.PublishOverride = (_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Redirect) { Headers = { { "Location", "https://evil.invalid/?SECRET" } } });
		writes = wire.Publishes.Count;
		result = await Publish(Request());
		Assert(result.Status == "unknown" && wire.Publishes.Count == writes + 1, "Redirect is not followed or treated as rejection proof");
		credential.Cancel = true;
		writes = wire.Publishes.Count;
		result = await Publish(Request());
		Assert(result.Status == "failed" && result.Uncertain == 0 && wire.Publishes.Count == writes, "Token failure before dispatch sends nothing");
		Console.WriteLine($"Event Grid publishing adapter checks passed ({count} assertions)");
		return 0;
	}
}
