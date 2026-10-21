using Azure;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.ResourceManager;
using MsgCommander.Host;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;

sealed class FixtureNotificationHubFactory : INotificationHubGatewayFactory
{
	public const string Root = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.NotificationHubs/namespaces/fixture";
	public async Task<INotificationHubGateway> ConnectAsync(ConnectionProfile profile, NotificationHubManagement management, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		if (profile.Namespace != "fixture.servicebus.windows.net" || management.ResourceId != Root)
			throw new OperationException(OperationFailure.InvalidInput, "Offline NotificationHub accepts only the fixture namespace.");
		if (management.TenantId == "denied")
			throw new RequestFailedException(403, "SECRET denied");
		if (management.TenantId == "slow")
		{
			await deviceCode(new("OFFLINE-NH", MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow.AddMinutes(5))));
			await Task.Delay(10000, cancellation);
		}
		var wire = new NotificationHubWire();
		wire.BeforeAsync = async (method, path, token) => { if ((method == "PATCH" && path.EndsWith("/provider-renew")) || (method == "PUT" && path.EndsWith("/config-renew"))) { await deviceCode(new("OFFLINE-PROVIDER", MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow.AddMinutes(5)))); await Task.Delay(10000, token); } };
		return await Connect(wire, cancellation);
	}
	public static Task<AzureNotificationHubGateway> Connect(NotificationHubWire wire, CancellationToken cancellation = default)
	{
		var options = new ArmClientOptions { Transport = new HttpClientTransport(new HttpClient(wire)), Retry = { MaxRetries = 0 } };
		return AzureNotificationHubGateway.ConnectAsync(new ArmClient(new Credential(), null, options), "fixture.servicebus.windows.net", Root, cancellation);
	}
	private sealed class Credential : TokenCredential
	{
		public override AccessToken GetToken(TokenRequestContext context, CancellationToken cancellation) => new("offline-nh", DateTimeOffset.UtcNow.AddHours(1));
		public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext context, CancellationToken cancellation) => ValueTask.FromResult(GetToken(context, cancellation));
	}
}
sealed class NotificationHubWire : HttpMessageHandler
{
	private const string Root = FixtureNotificationHubFactory.Root;
	public List<(string Method, string Path, string? Body)> Requests { get; } = [];
	public List<string> RawPaths { get; } = [];
	public Func<string, string, CancellationToken, Task>? BeforeAsync
	{
		get; set;
	}
	public bool MalformedPatchReply
	{
		get; set;
	}
	public string? NextLinkOverride
	{
		get; set;
	}
	public Action<string, string>? BeforeRequest
	{
		get; set;
	}
	private readonly Dictionary<string, JsonObject> entities = new(StringComparer.OrdinalIgnoreCase);
	private readonly Dictionary<string, (int Primary, int Secondary)> keys = new(StringComparer.OrdinalIgnoreCase);
	public NotificationHubWire()
	{
		foreach (var name in new[] { "alerts", "archive", "more-alerts" })
			Seed("notificationHubs", name, new()
			{
				["registrationTtl"] = "10675199.02:48:05.4775807",
				["registrationCount"] = 2,
				["createdAt"] = "2026-10-11T10:00:00Z",
				["futureSetting"] = "preserved",
				["gcmCredential"] = new JsonObject { ["properties"] = new JsonObject { ["googleApiKey"] = "SECRET-PNS" } },
				["authorizationRules"] = new JsonArray(new JsonObject { ["primaryKey"] = "SECRET-EMBEDDED-KEY" })
			});
		Policy("", "RootManageSharedAccessKey", ["Listen", "Send", "Manage"]);
		Policy("", "sender", ["Send"]);
		Policy("/notificationHubs/alerts", "alerts-reader", ["Listen"]);
	}
	public void Seed(string collection, string name, JsonObject properties)
	{
		var path = Root + "/" + collection + "/" + name;
		entities[path] = Entity(path, properties);
		entities[path]["location"] = "westeurope";
		entities[path]["tags"] = new JsonObject { ["environment"] = "fixture" };
	}
	public JsonObject Data(string suffix) => entities[Root + suffix];
	private void Policy(string suffix, string name, string[] rights)
	{
		var path = Root + suffix + "/authorizationRules/" + name;
		entities[path] = Entity(path, new()
		{
			["rights"] = new JsonArray(rights.Select(r => (JsonNode?)JsonValue.Create(r)).ToArray())
		});
		keys[path] = (1, 1);
	}
	private static JsonObject Entity(string path, JsonObject p) => new() { ["id"] = path, ["name"] = path.Contains("/authorizationRules/") ? path.Split('/').Last() : path.Split("/notificationHubs/").Last(), ["type"] = "Microsoft.NotificationHubs/namespaces", ["properties"] = p };
	private static HttpResponseMessage Reply(HttpStatusCode status, JsonNode? body = null) => new(status) { Content = new StringContent(body?.ToJsonString() ?? "", Encoding.UTF8, "application/json") };
	private static HttpResponseMessage Error(HttpStatusCode status) => Reply(status, new JsonObject { ["error"] = new JsonObject { ["code"] = status.ToString(), ["message"] = "SECRET NotificationHub failure" } });
	protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
	{
		var uri = request.RequestUri!;
		var path = Uri.UnescapeDataString(uri.AbsolutePath);
		var method = request.Method.Method;
		if (uri.Host != "management.azure.com" || (!path.Equals(Root, StringComparison.OrdinalIgnoreCase) && !path.StartsWith(Root + "/", StringComparison.OrdinalIgnoreCase)))
			throw new Exception("Escaped fixture ARM scope");
		var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellation);
		RawPaths.Add(uri.AbsolutePath);
		Requests.Add((method, path + uri.Query, body));
		BeforeRequest?.Invoke(method, path);
		if (BeforeAsync is { } before)
			await before(method, path, cancellation);
		if (path.Contains("denied"))
			return Error(HttpStatusCode.Forbidden);
		if (path.Contains("preflight-slow") && method == "GET")
			await Task.Delay(10000, cancellation);
		if (path == Root && method == "GET")
			return Reply(HttpStatusCode.OK, new JsonObject { ["id"] = Root, ["name"] = "fixture", ["type"] = "Microsoft.NotificationHubs/namespaces", ["location"] = "westeurope", ["sku"] = new JsonObject { ["name"] = "Standard", ["tier"] = "Standard" }, ["properties"] = new JsonObject { ["serviceBusEndpoint"] = "https://fixture.servicebus.windows.net/", ["provisioningState"] = "Succeeded" } });
		if (method == "GET")
		{
			if (entities.TryGetValue(path, out var entity))
				return Reply(HttpStatusCode.OK, entity);
			if (path.EndsWith("/notificationHubs") || path.EndsWith("/authorizationRules"))
			{
				var rows = entities.Where(x => x.Key.StartsWith(path + "/", StringComparison.OrdinalIgnoreCase) && (path.EndsWith("/authorizationRules") ? !x.Key[(path.Length + 1)..].Contains('/') : !x.Key[(path.Length + 1)..].Contains("/authorizationRules/"))).Select(x => x.Value).ToArray();
				var offset = uri.Query.Contains("page=2") ? 2 : 0;
				var page = new JsonObject { ["value"] = new JsonArray(rows.Skip(offset).Take(2).Select(v => (JsonNode?)v.DeepClone()).ToArray()) };
				if (offset == 0 && rows.Length > 2)
					page["nextLink"] = NextLinkOverride ?? "https://management.azure.com" + path + "?api-version=2023-09-01&page=2";
				return Reply(HttpStatusCode.OK, page);
			}
			return Error(HttpStatusCode.NotFound);
		}
		var isKeys = path.EndsWith("/listKeys") || path.EndsWith("/regenerateKeys");
		var keyPath = isKeys ? path[..path.LastIndexOf('/')] : path;
		if (method is "PUT" or "PATCH" or "DELETE" || path.EndsWith("/regenerateKeys"))
		{
			if (path.Contains("rejected"))
				return Error(HttpStatusCode.BadRequest);
			if (path.Contains("write-slow"))
				await Task.Delay(10000, cancellation);
			if (path.Contains("late"))
				await Task.Delay(300);
		}
		if (method is "PUT" or "PATCH")
		{
			var data = JsonNode.Parse(body!)!.AsObject();
			if (method == "PATCH")
			{
				if (!entities.TryGetValue(path, out var current))
					return Error(HttpStatusCode.NotFound);
				foreach (var prop in data["properties"]!.AsObject())
					current["properties"]![prop.Key] = prop.Value?.DeepClone();
				if (data["tags"] is { } tags)
					current["tags"] = tags.DeepClone();
			}
			else
			{
				if (!path.Contains("/authorizationRules/") && data["location"]?.GetValue<string>() != "westeurope")
					throw new Exception("Location missing on create");
				entities[path] = Entity(path, data["properties"]!.DeepClone().AsObject());
				if (data["tags"] is { } tags)
					entities[path]["tags"] = tags.DeepClone();
				if (data["location"] is { } location)
					entities[path]["location"] = location.DeepClone();
			}
			if (path.Contains("/authorizationRules/"))
				keys.TryAdd(path, (1, 1));
			if (method == "PATCH" && MalformedPatchReply)
				return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("SECRET invalid response JSON") };
			if (path.Contains("unknown") && !(path.EndsWith("/unknown-provider") && method == "PUT"))
				throw new IOException("SECRET lost accepted write response");
			return Reply(path.Contains("async-accepted") ? HttpStatusCode.Accepted : HttpStatusCode.OK, entities[path]);
		}
		if (method == "DELETE")
		{
			if (!entities.Remove(path))
				return Error(HttpStatusCode.NotFound);
			foreach (var child in entities.Keys.Where(k => k.StartsWith(path + "/", StringComparison.OrdinalIgnoreCase)).ToArray())
				entities.Remove(child);
			if (path.Contains("unknown"))
				throw new IOException("SECRET lost accepted DELETE response");
			return Reply(HttpStatusCode.NoContent);
		}
		if (method == "POST" && isKeys)
		{
			if (!entities.ContainsKey(keyPath))
				return Error(HttpStatusCode.NotFound);
			var slots = keys[keyPath];
			if (path.EndsWith("/regenerateKeys"))
			{
				var slot = JsonNode.Parse(body!)!["policyKey"]!.GetValue<string>();
				slots = slot == "PrimaryKey" ? (slots.Primary + 1, slots.Secondary) : (slots.Primary, slots.Secondary + 1);
				keys[keyPath] = slots;
				if (path.Contains("unknown"))
					throw new IOException("SECRET lost rotation response");
			}
			var primary = "OFFLINE-NH-PRIMARY-" + slots.Primary;
			var secondary = "OFFLINE-NH-SECONDARY-" + slots.Secondary;
			var scope = keyPath[..keyPath.LastIndexOf("/authorizationRules/", StringComparison.Ordinal)];
			string Connection(string key) => "Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=" + keyPath.Split('/').Last() + ";SharedAccessKey=" + key + (scope == Root ? "" : ";EntityPath=" + scope.Split('/').Last());
			return Reply(HttpStatusCode.OK, new JsonObject { ["primaryKey"] = primary, ["secondaryKey"] = secondary, ["primaryConnectionString"] = Connection(primary), ["secondaryConnectionString"] = Connection(secondary) });
		}
		throw new Exception("Unexpected fixture NotificationHub request");
	}
}
