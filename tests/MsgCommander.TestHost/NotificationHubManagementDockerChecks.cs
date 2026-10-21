using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.ResourceManager;

static class NotificationHubManagementDockerChecks
{
	static readonly Uri Fixture = new("http://127.0.0.1:5303");
	static readonly NotificationHubTarget Target = new(new("hub", "alerts"), null);
	static string Id() => Guid.NewGuid().ToString();
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	public static async Task<int> Run()
	{
		using var budget = new CancellationTokenSource(TimeSpan.FromSeconds(45));
		var token = budget.Token;
		using var control = new HttpClient { BaseAddress = Fixture };
		async Task Mode(string mode)
		{
			using var response = await control.PostAsync("/__mode?value=" + mode, null, token);
			response.EnsureSuccessStatusCode();
		}
		async Task<JsonElement> Stats() => (await control.GetFromJsonAsync<JsonElement>("/__stats", token)).Clone();
		async Task<int> Writes() => (await Stats()).GetProperty("writes").GetInt32();
		using (var reset = await control.PostAsync("/__reset", null, token))
			reset.EnsureSuccessStatusCode();
		using var factory = new Factory();
		await using var owner = new NotificationHubManagementOwner(factory, new AzureProviderCredentialCodec(), new AzureNotificationHubFailureClassifier());
		var request = new NotificationHubManagementConnect(Id(), new(Id(), "Docker", "notification-hubs", "fixture.servicebus.windows.net", "device-code", "fixture", Id(), null), new(FixtureNotificationHubFactory.Root, "fixture", Id()));
		var connection = await owner.ConnectAsync(() => request, null, token);
		await owner.ExecuteAsync(connection.ConnectionId, Id(), null, async (context, ct) =>
		{
			var page = await context.Browsing.ListAsync(new("namespace", ""), "hubs", null, ct);
			Assert(page.Items.Single().Target == Target, "Production browsing reads the external fixture");
			var details = await context.Gateway.GetAsync(Target, ct);
			Assert(!JsonSerializer.Serialize(details).Contains("DOCKER-SECRET"), "Provider and embedded policy keys are filtered");
			var change = new NotificationHubChange(Id(), connection.ConnectionId, Target, "update", details.Revision, new("60.00:00:00", [new("purpose", "updated")]), null, null, true);
			var result = await context.Administration.ChangeAsync(change, "reviewed-admin", ct);
			Assert(result.Status == "confirmed" && (await context.Gateway.GetAsync(Target, ct)).Settings!.RegistrationTtl == "60.00:00:00", "Reviewed update is acknowledged and re-readable");
			Assert(ReferenceEquals(result, await context.Administration.ChangeAsync(change, "reviewed-admin", ct)) && await Writes() == 1, "Receipt replay never repeats an HTTP write");
			var patch = (await Stats()).GetProperty("lastPatch");
			Assert(patch.GetProperty("properties").EnumerateObject().Count() == 1 && !patch.TryGetProperty("location", out _), "Settings patch excludes provider secrets and unrelated properties");
			var exported = await context.Configuration.ExportAsync(new("namespace", ""), "json", ct);
			Assert(!Encoding.UTF8.GetString(Convert.FromBase64String(exported.ContentBase64)).Contains("DOCKER-SECRET"), "Configuration export never includes private provider or policy keys");
			async Task<NotificationHubOutcome> Credential(string stamp)
			{
				var status = await context.Gateway.CredentialsAsync(Target, "wns", ct);
				var review = new ProviderCredentialReview(Id(), Target, status.Revision, true);
				var draft = new ProviderCredentialDraft("wns", null, new Dictionary<string, string?> { ["packageSid"] = "ms-app://fixture", ["secretKey"] = "DOCKER-SECRET-WNS" });
				var value = await context.Credentials.ChangeAsync(review, stamp, () => draft, ct);
				var count = await Writes();
				Assert(ReferenceEquals(value, await context.Credentials.ChangeAsync(review, stamp, () => throw new Exception("Reparsed a replay"), ct)) && await Writes() == count, "Credential replay uses the retained result");
				return value;
			}
			Assert((await Credential("provider-confirmed")).Status == "confirmed", "Scoped provider update is acknowledged");
			patch = (await Stats()).GetProperty("lastPatch");
			Assert(patch.EnumerateObject().Count() == 1 && patch.GetProperty("properties").EnumerateObject().Single().Name == "wnsCredential", "Provider PATCH affects exactly the selected provider");
			Assert(!JsonSerializer.Serialize(await context.Gateway.CredentialsAsync(Target, "wns", ct)).Contains("DOCKER-SECRET"), "Credential status remains redacted");
			await Mode("disconnect-write");
			var countBefore = await Writes();
			Assert((await Credential("provider-lost-response")).Status == "unknown" && await Writes() == countBefore + 1, "Dropped write reply is uncertain with no SDK retry");
			await Mode("slow-write");
			details = await context.Gateway.GetAsync(Target, ct);
			var interrupted = change with
			{
				Id = Id(),
				ExpectedRevision = details.Revision,
				Settings = new("90.00:00:00", [])
			};
			using var cancelled = CancellationTokenSource.CreateLinkedTokenSource(ct);
			countBefore = await Writes();
			var pending = context.Administration.ChangeAsync(interrupted, "cancelled-write", cancelled.Token);
			while (await Writes() == countBefore)
				await Task.Delay(10, ct);
			cancelled.Cancel();
			var uncertain = await pending;
			Assert(uncertain.Status == "unknown", "Cancellation after dispatch cannot claim no change occurred");
			Assert(ReferenceEquals(uncertain, await context.Administration.ChangeAsync(interrupted, "cancelled-write", ct)) && await Writes() == countBefore + 1, "Interrupted write replay cannot dispatch again");
			return 0;
		}, token);
		await owner.ResetAsync(token);
		await Mode("normal");
		var next = await owner.ConnectAsync(() => request, null, token);
		Assert(next.ConnectionId != connection.ConnectionId && factory.Credential.Scopes.Contains(ArmEnvironment.AzurePublicCloud.DefaultScope), "Explicit reconnect uses a fresh management generation and ARM audience");
		Console.WriteLine("Notification Hubs management Docker contract checks passed");
		return 0;
	}
	sealed class Factory : INotificationHubGatewayFactory, IDisposable
	{
		public readonly Credential Credential = new();
		readonly HttpClient http = new(new LoopbackTransport()) { Timeout = TimeSpan.FromSeconds(20) };
		public Task<INotificationHubGateway> ConnectAsync(ConnectionProfile profile, NotificationHubManagement management, Func<DeviceCodeEvent, Task> prompt, CancellationToken token) => Connect(profile, management, token);
		async Task<INotificationHubGateway> Connect(ConnectionProfile profile, NotificationHubManagement management, CancellationToken token)
		{
			var arm = new ArmClient(Credential, null, new ArmClientOptions { Transport = new HttpClientTransport(http), Retry = { MaxRetries = 0 }, Diagnostics = { IsLoggingContentEnabled = false } });
			return await AzureNotificationHubGateway.ConnectAsync(arm, profile.Namespace, management.ResourceId, token);
		}
		public void Dispose() => http.Dispose();
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
	// Only this test handler redirects the single expected Azure management authority.
	sealed class LoopbackTransport() : DelegatingHandler(new SocketsHttpHandler { AllowAutoRedirect = false })
	{
		protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
		{
			var original = request.RequestUri!;
			if (original.Scheme != "https" || original.Host != "management.azure.com")
				throw new InvalidOperationException("Unexpected fixture authority.");
			request.Headers.Add("x-fixture-authority", original.Host);
			request.Headers.Host = null;
			request.RequestUri = new Uri(Fixture, original.PathAndQuery);
			return base.SendAsync(request, token);
		}
	}
}
