using MsgCommander.Application.EventGrid.Administration;
using System.Net.Http.Json;
using System.Text.Json;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.ResourceManager;

static class EventGridDockerChecks
{
	static string Id() => Guid.NewGuid().ToString();
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	static readonly EventGridTarget Target = new("subscription", "orders", "fulfillment");
	static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	static readonly Uri Fixture = new("http://127.0.0.1:5302");
	public static async Task<int> Run()
	{
		using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(45));
		var token = deadline.Token;
		using var control = new HttpClient { BaseAddress = Fixture, Timeout = TimeSpan.FromSeconds(5) };
		async Task Scenario(string mode, bool reset = false)
		{
			using var result = await control.PostAsJsonAsync("/__fixture/control", new
			{
				scenario = mode,
				reset
			}, token);
			result.EnsureSuccessStatusCode();
		}
		async Task<int> Count(string name)
		{
			var value = await control.GetFromJsonAsync<JsonElement>("/__fixture/stats", token);
			return value.GetProperty(name).GetInt32();
		}
		async Task WaitCount(string name, int before)
		{
			using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(5));
			while (await Count(name) <= before)
				await Task.Delay(10, wait.Token);
		}
		await Scenario("normal", true);
		var factory = new Factory();
		await using var owner = new EventGridConnectionOwner(factory, new AzureEventGridFailureClassifier());
		var setup = new EventGridConnect(new(Id(), "Docker Grid", "event-grid", FixtureEventGridFactory.Host, "device-code", "", "", ""),
			new(FixtureEventGridFactory.Root, "fixture", "22222222-2222-4222-8222-222222222222"));
		var connection = await owner.ConnectAsync(() => setup, null, token);
		await owner.ExecuteAsync(connection.ConnectionId, null, async (context, ct) =>
		{
			var topic = new EventGridTarget("topic", "orders", null);
			var page = await context.Browsing.ListAsync(new("namespace", null, null), null, ct);
			Assert(page.Items.Single().Target == topic, "ARM browsing crosses the Docker HTTP boundary");
			var before = await context.Browsing.AdminGetAsync(topic, ct);
			var change = new EventGridAdminChange(Id(), connection.ConnectionId, topic, "update", before.Revision, 6, null, null, true, null);
			var updated = await context.Administration.ChangeAsync(EventGridCommands.Prepare(change), "admin", ct);
			Assert(updated.Status == "confirmed" && (await context.Browsing.AdminGetAsync(topic, ct)).RetentionDays == 6, "Reviewed topic change is acknowledged and re-readable");
			Assert(ReferenceEquals(await context.Administration.ChangeAsync(EventGridCommands.Prepare(change), "admin", ct), updated) && await Count("adminWrites") == 1, "Administration receipt replay cannot write twice");
			CloudEventDraft Draft() => new(Id(), "/orders", "Order.Created", "orders/new", "", "application/json", "", "json", "{\"sequence\":9007199254740993,\"label\":\"ordré🌍\"}", []);
			async Task<EventGridPublishOutcome> Publish(int count = 1)
			{
				var p = new EventGridPublish(Id(), connection.ConnectionId, "orders", count == 1 ? "single" : "batch", Enumerable.Range(0, count).Select(_ => Draft()).ToArray(), 2, 5, 0, true);
				return await context.Publishing.ExecuteAsync(p, p.Id, _ => Task.CompletedTask, ct);
			}
			Task<EventGridPullOutcome> Receive(int count = 1, CancellationToken? cancellation = null) => context.Pull.ReceiveAsync(new(Id(), connection.ConnectionId, Target, count, Math.Min(count, 2), 10, 5, true), Id(), _ => Task.CompletedTask, cancellation ?? ct);
			var published = await Publish(3);
			Assert(published.Confirmed == 3 && published.ConfirmedBatches == 2 && await Count("publishRequests") == 2, "CloudEvents are acknowledged in bounded HTTP batches");
			var received = await Receive(3);
			Assert(received.Confirmed == 3 && received.Status == "completed", "Batched receives retain opaque handles");
			var inspected = context.Pull.Inspect(Target, received.Handles[0]);
			Assert(inspected.EventJson.Contains("9007199254740993") && !inspected.EventJson.Contains("DOCKER-SECRET"), "Exact JSON survives the external fixture without exposing broker leases");
			using var payload = JsonDocument.Parse(inspected.EventJson);
			Assert(payload.RootElement.GetProperty("data").GetProperty("label").GetString() == "ordré🌍", "UTF-8 event data survives socket chunking");
			await Scenario("partial-settle");
			var settle = new EventGridSettle(Id(), connection.ConnectionId, Target, "acknowledge", received.Handles, 0, true);
			var partial = await context.Pull.SettleAsync(settle, "partial", _ => Task.CompletedTask, ct);
			Assert(partial.Confirmed == 2 && partial.Failed == 1 && partial.Uncertain == 0 && partial.Results[0].ErrorCode == "TokenLost" && !JsonSerializer.Serialize(partial, Json).Contains("DOCKER-SECRET"), "Per-event settlement preserves confirmed success and sanitizes error details");
			Assert(ReferenceEquals(await context.Pull.SettleAsync(settle, "partial", _ => Task.CompletedTask, ct), partial) && await Count("settleRequests") == 1, "Settlement receipt replay sends no duplicate HTTP request");
			foreach (var mode in new[] { "disconnect-settle", "truncate-settle" })
			{
				await Scenario("normal");
				await Publish();
				var locked = await Receive();
				await Scenario(mode);
				var count = await Count("settleRequests");
				var request = new EventGridSettle(Id(), connection.ConnectionId, Target, "release", locked.Handles, 10, true);
				var outcome = await context.Pull.SettleAsync(request, mode, _ => Task.CompletedTask, ct);
				Assert(outcome.Status == "unknown" && outcome.Uncertain == 1 && outcome.Confirmed == 0 && context.Pull.List(Target).Single(x => x.Handle == locked.Handles[0]).State == "unknown", mode + " keeps a truthful receipt and invalidates the lease");
				Assert(ReferenceEquals(await context.Pull.SettleAsync(request, mode, _ => Task.CompletedTask, ct), outcome) && await Count("settleRequests") == count + 1, mode + " never automatically retries");
			}
			await Scenario("normal");
			await Publish();
			await Scenario("delayed-body");
			var headers = await Count("headersSent");
			using var late = new CancellationTokenSource();
			var completeBody = Receive(cancellation: late.Token);
			await WaitCount("headersSent", headers);
			late.Cancel();
			var acknowledged = await completeBody;
			Assert(acknowledged.Status == "completed" && acknowledged.Confirmed == 1, "A complete HTTP response body wins cancellation after headers");
			await Scenario("normal");
			await Publish();
			await Scenario("slow-receive");
			var reads = await Count("receiveRequests");
			using var cancel = new CancellationTokenSource();
			var inFlight = Receive(cancellation: cancel.Token);
			await WaitCount("receiveRequests", reads);
			cancel.Cancel();
			var interrupted = await inFlight;
			Assert(interrupted.Status == "unknown" && interrupted.Uncertain == 1 && interrupted.Confirmed == 0, "Cancellation after receive dispatch does not claim there were no broker locks");
			Assert(factory.Credential.Scopes.Any(scope => scope == "https://eventgrid.azure.net/.default"), "Data-plane requests use the Event Grid audience");
			Console.WriteLine("Event Grid Docker: ARM review, publishing, exact JSON, partial settlement, dropped/truncated replies and cancellation passed");
			return 0;
		}, token);
		var settlements = await Count("settleRequests");
		await owner.ResetAsync(token);
		Assert(await Count("settleRequests") == settlements && owner.Connection is null, "Disconnect performs no hidden settlement");
		await Scenario("normal");
		var next = await owner.ConnectAsync(() => setup, null, token);
		Assert(next.ConnectionId != connection.ConnectionId, "Explicit reconnect creates a new generation after transport interruption");
		Console.WriteLine("Event Grid Docker contract checks passed");
		return 0;
	}
	sealed class Factory : IEventGridGatewayFactory
	{
		public readonly Credential Credential = new();
		public async Task<IEventGridGateway> ConnectAsync(ConnectionProfile profile, EventGridManagement management, Func<DeviceCodeEvent, Task> prompt, CancellationToken token)
		{
			var http = new HttpClient(new LoopbackTransport()) { Timeout = TimeSpan.FromSeconds(30) };
			var arm = new ArmClient(Credential, null, new ArmClientOptions { Transport = new HttpClientTransport(http), Retry = { MaxRetries = 0 }, Diagnostics = { IsLoggingContentEnabled = false } });
			try
			{
				return await AzureEventGridGateway.ConnectAsync(arm, profile.Namespace, management.ResourceId, token, http, Credential, http);
			}
			catch { http.Dispose(); throw; }
		}
	}
	sealed class Credential : TokenCredential
	{
		public readonly HashSet<string> Scopes = [];
		public override AccessToken GetToken(TokenRequestContext context, CancellationToken token)
		{
			foreach (var scope in context.Scopes)
				Scopes.Add(scope);
			return new("fixture-docker-token", DateTimeOffset.UtcNow.AddHours(1));
		}
		public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext context, CancellationToken token) => ValueTask.FromResult(GetToken(context, token));
	}
	// Only this test transport redirects the two known Azure authorities to the loopback fixture.
	sealed class LoopbackTransport() : DelegatingHandler(new SocketsHttpHandler { AllowAutoRedirect = false })
	{
		protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
		{
			var original = request.RequestUri!;
			if (original.Scheme != "https" || original.Host is not ("management.azure.com" or FixtureEventGridFactory.Host))
				throw new InvalidOperationException("Unexpected fixture authority.");
			request.Headers.Add("x-fixture-authority", original.Host);
			request.Headers.Host = null;
			request.RequestUri = new Uri(Fixture, original.PathAndQuery);
			return base.SendAsync(request, token);
		}
	}
}
