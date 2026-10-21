using Azure;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.ResourceManager;
using Azure.ResourceManager.Relay;
using MsgCommander.Host;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;

sealed class FixtureRelayFactory : IRelayGatewayFactory
{
	public const string Root = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.Relay/namespaces/fixture";
	public async Task<IRelayGateway> ConnectAsync(ConnectionProfile profile, RelayManagement management, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		if (profile.Namespace != "fixture.servicebus.windows.net" || management.ResourceId != Root)
			throw new OperationException(OperationFailure.InvalidInput, "Offline Relay accepts only the fixture namespace.");
		if (management.TenantId == "denied")
			throw new RequestFailedException(403, "SECRET denied");
		if (management.TenantId == "slow")
		{
			await deviceCode(new("OFFLINE-RELAY", MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow.AddMinutes(5))));
			await Task.Delay(10000, cancellation);
		}
		return await Connect(new RelayWire(), cancellation);
	}
	public static Task<AzureRelayGateway> Connect(RelayWire wire, CancellationToken cancellation = default)
	{
		var options = new ArmClientOptions { Transport = new HttpClientTransport(new HttpClient(wire)), Retry = { MaxRetries = 0 } };
		options.SetApiVersion(RelayNamespaceResource.ResourceType, "2024-01-01");
		return AzureRelayGateway.ConnectAsync(new ArmClient(new Credential(), null, options), "fixture.servicebus.windows.net", Root, cancellation);
	}
	private sealed class Credential : TokenCredential
	{
		public override AccessToken GetToken(TokenRequestContext context, CancellationToken cancellation) => new("offline-relay", DateTimeOffset.UtcNow.AddHours(1));
		public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext context, CancellationToken cancellation) => ValueTask.FromResult(GetToken(context, cancellation));
	}
}
sealed class RelayWire : HttpMessageHandler
{
	private const string Root = FixtureRelayFactory.Root;
	public List<(string Method, string Path, string? Body)> Requests { get; } = [];
	public List<string> RawPaths { get; } = [];
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
	public RelayWire()
	{
		foreach (var name in new[] { "bridge", "archive", "more-bridge" })
			Seed("hybridConnections", name, new()
			{
				["requiresClientAuthorization"] = true,
				["userMetadata"] = "Fixture Hybrid Connection",
				["listenerCount"] = 2,
				["createdAt"] = "2026-10-11T10:00:00Z",
				["futureSetting"] = "preserved"
			});
		Seed("wcfRelays", "legacy", new()
		{
			["requiresClientAuthorization"] = true,
			["requiresTransportSecurity"] = true,
			["relayType"] = "NetTcp",
			["listenerCount"] = 1,
			["isDynamic"] = false,
			["userMetadata"] = "Fixture WCF resource"
		});
		Policy("", "RootManageSharedAccessKey", ["Listen", "Send", "Manage"]);
		Policy("", "sender", ["Send"]);
		Policy("/hybridConnections/bridge", "bridge-reader", ["Listen"]);
		Policy("/wcfRelays/legacy", "legacy-reader", ["Listen"]);
	}
	public void Seed(string collection, string name, JsonObject properties)
	{
		var path = Root + "/" + collection + "/" + name;
		entities[path] = Entity(path, properties);
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
	private static JsonObject Entity(string path, JsonObject p) => new() { ["id"] = path, ["name"] = path.Contains("/authorizationRules/") ? path.Split('/').Last() : path.Split("/hybridConnections/").Last().Split("/wcfRelays/").Last(), ["type"] = "Microsoft.Relay/namespaces", ["properties"] = p };
	private static HttpResponseMessage Reply(HttpStatusCode status, JsonNode? body = null) => new(status) { Content = new StringContent(body?.ToJsonString() ?? "", Encoding.UTF8, "application/json") };
	private static HttpResponseMessage Error(HttpStatusCode status) => Reply(status, new JsonObject { ["error"] = new JsonObject { ["code"] = status.ToString(), ["message"] = "SECRET Relay failure" } });
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
		if (path.Contains("denied"))
			return Error(HttpStatusCode.Forbidden);
		if (path.Contains("preflight-slow") && method == "GET")
			await Task.Delay(10000, cancellation);
		if (path == Root && method == "GET")
			return Reply(HttpStatusCode.OK, new JsonObject { ["id"] = Root, ["name"] = "fixture", ["type"] = "Microsoft.Relay/namespaces", ["location"] = "westeurope", ["sku"] = new JsonObject { ["name"] = "Standard", ["tier"] = "Standard" }, ["properties"] = new JsonObject { ["serviceBusEndpoint"] = "https://fixture.servicebus.windows.net/", ["provisioningState"] = "Succeeded" } });
		if (method == "GET")
		{
			if (entities.TryGetValue(path, out var entity))
				return Reply(HttpStatusCode.OK, entity);
			if (path.EndsWith("/hybridConnections") || path.EndsWith("/wcfRelays") || path.EndsWith("/authorizationRules"))
			{
				var rows = entities.Where(x => x.Key.StartsWith(path + "/", StringComparison.OrdinalIgnoreCase) && (path.EndsWith("/authorizationRules") ? !x.Key[(path.Length + 1)..].Contains('/') : !x.Key[(path.Length + 1)..].Contains("/authorizationRules/"))).Select(x => x.Value).ToArray();
				var offset = uri.Query.Contains("page=2") ? 2 : 0;
				var page = new JsonObject { ["value"] = new JsonArray(rows.Skip(offset).Take(2).Select(v => (JsonNode?)v.DeepClone()).ToArray()) };
				if (offset == 0 && rows.Length > 2)
					page["nextLink"] = NextLinkOverride ?? "https://management.azure.com" + path + "?api-version=2024-01-01&page=2";
				return Reply(HttpStatusCode.OK, page);
			}
			return Error(HttpStatusCode.NotFound);
		}
		var isKeys = path.EndsWith("/listKeys") || path.EndsWith("/regenerateKeys");
		var keyPath = isKeys ? path[..path.LastIndexOf('/')] : path;
		if (method is "PUT" or "DELETE" || path.EndsWith("/regenerateKeys"))
		{
			if (path.Contains("rejected"))
				return Error(HttpStatusCode.BadRequest);
			if (path.Contains("write-slow"))
				await Task.Delay(10000, cancellation);
			if (path.Contains("late"))
				await Task.Delay(300);
		}
		if (method == "PUT")
		{
			entities[path] = Entity(path, JsonNode.Parse(body!)!["properties"]!.DeepClone().AsObject());
			if (path.Contains("/authorizationRules/"))
				keys.TryAdd(path, (1, 1));
			if (path.Contains("unknown"))
				throw new IOException("SECRET lost accepted PUT response");
			return Reply(HttpStatusCode.OK, entities[path]);
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
				var slot = JsonNode.Parse(body!)!["keyType"]!.GetValue<string>();
				slots = slot == "PrimaryKey" ? (slots.Primary + 1, slots.Secondary) : (slots.Primary, slots.Secondary + 1);
				keys[keyPath] = slots;
				if (path.Contains("unknown"))
					throw new IOException("SECRET lost rotation response");
			}
			var primary = "OFFLINE-RELAY-PRIMARY-" + slots.Primary;
			var secondary = "OFFLINE-RELAY-SECONDARY-" + slots.Secondary;
			var scope = keyPath[..keyPath.LastIndexOf("/authorizationRules/", StringComparison.Ordinal)];
			string Connection(string key) => "Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=" + keyPath.Split('/').Last() + ";SharedAccessKey=" + key + (scope == Root ? "" : ";EntityPath=" + scope.Split('/').Last());
			return Reply(HttpStatusCode.OK, new JsonObject { ["primaryKey"] = primary, ["secondaryKey"] = secondary, ["primaryConnectionString"] = Connection(primary), ["secondaryConnectionString"] = Connection(secondary) });
		}
		throw new Exception("Unexpected fixture Relay request");
	}
}
