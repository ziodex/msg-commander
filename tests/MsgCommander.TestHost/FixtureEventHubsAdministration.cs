using System.Net;
using System.Text;
using System.Text.Json.Nodes;

sealed class EventHubsWire : HttpMessageHandler
{
	public List<string> Paths { get; } = [];
	public List<(string Method, string Path, string? Body)> Requests { get; } = [];
	public string Tier { get; set; } = "Standard";
	public Func<string, CancellationToken, Task>? BeforeRequest;
	private readonly Dictionary<string, JsonObject> entities = new(StringComparer.OrdinalIgnoreCase);
	private readonly Dictionary<string, (int Primary, int Secondary)> keys = new(StringComparer.OrdinalIgnoreCase);
	private const string Root = FixtureEventHubsGateway.ResourceId;
	public EventHubsWire()
	{
		foreach (var name in new[] { "telemetry", "paced", "large", "archive" })
			SeedHub(name);
		foreach (var name in new[] { "$Default", "dashboard", "audit" })
			SeedGroup("telemetry", name);
		SeedPolicy("", "RootManageSharedAccessKey", ["Listen", "Send", "Manage"]);
		SeedPolicy("", "publisher", ["Send"]);
		SeedPolicy("telemetry", "hub-reader", ["Listen"]);
	}
	public bool HasHub(string name) => entities.ContainsKey(Root + "/eventhubs/" + name);
	public void SeedHub(string name, JsonObject? properties = null)
	{
		var path = Root + "/eventhubs/" + name;
		entities[path] = Entity(path, properties ?? new JsonObject { ["partitionCount"] = 2, ["status"] = "Active", ["partitionIds"] = new JsonArray("0", "1"), ["retentionDescription"] = new JsonObject { ["cleanupPolicy"] = "Delete", ["retentionTimeInHours"] = 24 }, ["createdAt"] = "2026-10-11T10:00:00Z", ["userMetadata"] = "Fixture hub", ["futureSetting"] = "preserved" });
		SeedGroup(name, "$Default");
	}
	public void SeedGroup(string hub, string name)
	{
		var path = Root + "/eventhubs/" + hub + "/consumergroups/" + name;
		entities[path] = Entity(path, new JsonObject { ["userMetadata"] = "Fixture consumer group", ["createdAt"] = "2026-10-11T10:00:00Z" });
	}
	public void SeedPolicy(string hub, string name, string[] rights)
	{
		var path = Root + (hub == "" ? "" : "/eventhubs/" + hub) + "/authorizationRules/" + name;
		entities[path] = Entity(path, new JsonObject { ["rights"] = new JsonArray(rights.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()) });
		keys[path] = (1, 1);
	}
	public JsonObject Data(string path) => entities[path];
	private static JsonObject Entity(string path, JsonObject properties) => new() { ["id"] = path, ["name"] = path.Split('/').Last(), ["type"] = "Microsoft.EventHub/namespaces/" + (path.Contains("/authorizationRules/", StringComparison.OrdinalIgnoreCase) ? "authorizationRules" : path.Contains("/consumergroups/", StringComparison.OrdinalIgnoreCase) ? "eventhubs/consumergroups" : "eventhubs"), ["properties"] = properties };
	private static HttpResponseMessage Reply(HttpStatusCode status, JsonNode? data = null) => new(status) { Content = new StringContent(data?.ToJsonString() ?? "", Encoding.UTF8, "application/json") };
	private static HttpResponseMessage Error(HttpStatusCode status) => Reply(status, new JsonObject { ["error"] = new JsonObject { ["code"] = status.ToString(), ["message"] = "SECRET fixture Azure failure" } });
	protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
	{
		if (request.RequestUri!.Host != "management.azure.com")
			throw new Exception("Escaped fixture ARM host");
		var path = Uri.UnescapeDataString(request.RequestUri.AbsolutePath);
		if (!path.Equals(Root, StringComparison.OrdinalIgnoreCase) && !path.StartsWith(Root + "/", StringComparison.OrdinalIgnoreCase))
			throw new Exception("Escaped fixture ARM scope");
		var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellation);
		Paths.Add(path + request.RequestUri.Query);
		Requests.Add((request.Method.Method, path, body));
		if (BeforeRequest is not null)
			await BeforeRequest(path, cancellation);
		if (path.Contains("admin-preflight-slow") && request.Method == HttpMethod.Get)
			await Task.Delay(10000, cancellation);
		if (path.Contains("admin-denied"))
			return Error(HttpStatusCode.Forbidden);
		if (path == Root && request.Method == HttpMethod.Get)
			return Reply(HttpStatusCode.OK, new JsonObject { ["id"] = Root, ["name"] = "fixture", ["type"] = "Microsoft.EventHub/namespaces", ["location"] = "westeurope", ["sku"] = new JsonObject { ["name"] = Tier, ["tier"] = Tier }, ["properties"] = new JsonObject { ["serviceBusEndpoint"] = "https://fixture.servicebus.windows.net/", ["disableLocalAuth"] = false } });
		if (request.Method == HttpMethod.Get)
		{
			if (entities.TryGetValue(path, out var entity))
				return Reply(HttpStatusCode.OK, entity);
			if (path.EndsWith("/eventhubs", StringComparison.OrdinalIgnoreCase) || path.EndsWith("/consumergroups", StringComparison.OrdinalIgnoreCase) || path.EndsWith("/authorizationRules", StringComparison.OrdinalIgnoreCase))
			{
				var rows = entities.Where(x => x.Key.StartsWith(path + "/", StringComparison.OrdinalIgnoreCase) && !x.Key[(path.Length + 1)..].Contains('/')).Select(x => x.Value).ToArray();
				var page2 = request.RequestUri.Query.Contains("fixturePage=2");
				// Preserve original browsing fixtures' pages while including newly created entities.
				var split = path.EndsWith("/authorizationRules", StringComparison.OrdinalIgnoreCase) ? 1 : path.EndsWith("/eventhubs", StringComparison.OrdinalIgnoreCase) ? 3 : 2;
				var values = page2 ? rows.Skip(split) : rows.Take(split);
				var response = new JsonObject { ["value"] = new JsonArray(values.Select(x => (JsonNode?)x.DeepClone()).ToArray()) };
				if (!page2 && rows.Length > split)
					response["nextLink"] = "https://management.azure.com" + request.RequestUri.AbsolutePath + "?api-version=2026-01-01&fixturePage=2";
				return Reply(HttpStatusCode.OK, response);
			}
			return Error(HttpStatusCode.NotFound);
		}
		var isKeys = path.EndsWith("/listKeys", StringComparison.OrdinalIgnoreCase) || path.EndsWith("/regenerateKeys", StringComparison.OrdinalIgnoreCase);
		var target = isKeys ? path[..path.LastIndexOf('/')] : path;
		if (request.Method == HttpMethod.Put || request.Method == HttpMethod.Delete || path.EndsWith("/regenerateKeys", StringComparison.OrdinalIgnoreCase))
		{
			if (path.Contains("admin-rejected"))
				return Error(HttpStatusCode.BadRequest);
			if (path.Contains("admin-slow"))
				await Task.Delay(10000, cancellation);
			if (path.Contains("admin-late"))
				await Task.Delay(300);
		}
		if (request.Method == HttpMethod.Put)
		{
			var exists = entities.ContainsKey(path);
			var parsed = JsonNode.Parse(body!)!.AsObject();
			if (path.Contains("/consumergroups/", StringComparison.OrdinalIgnoreCase) || path.Contains("/authorizationRules/", StringComparison.OrdinalIgnoreCase))
			{
				var parent = path[..path.LastIndexOf('/')];
				parent = parent[..parent.LastIndexOf('/')];
				if (parent != Root && !entities.ContainsKey(parent))
					return Error(HttpStatusCode.NotFound);
			}
			entities[path] = Entity(path, parsed["properties"]!.DeepClone().AsObject());
			if (path.Contains("/authorizationRules/", StringComparison.OrdinalIgnoreCase))
				keys.TryAdd(path, (1, 1));
			else if (!path.Contains("/consumergroups/", StringComparison.OrdinalIgnoreCase))
			{
				var properties = entities[path]["properties"]!.AsObject();
				properties["partitionIds"] = new JsonArray(Enumerable.Range(0, properties["partitionCount"]!.GetValue<int>()).Select(i => (JsonNode?)JsonValue.Create(i.ToString())).ToArray());
				if (!exists)
					SeedGroup(path.Split('/').Last(), "$Default");
			}
			if (path.Contains("admin-unknown"))
				throw new IOException("SECRET response lost after accepted PUT");
			return Reply(exists ? HttpStatusCode.OK : HttpStatusCode.Created, entities[path]);
		}
		if (request.Method == HttpMethod.Delete)
		{
			if (!entities.Remove(path))
				return Error(HttpStatusCode.NotFound);
			foreach (var child in entities.Keys.Where(k => k.StartsWith(path + "/", StringComparison.OrdinalIgnoreCase)).ToArray())
				entities.Remove(child);
			if (path.Contains("admin-unknown"))
				throw new IOException("SECRET response lost after accepted DELETE");
			return Reply(HttpStatusCode.NoContent);
		}
		if (request.Method == HttpMethod.Post && isKeys)
		{
			if (!entities.ContainsKey(target))
				return Error(HttpStatusCode.NotFound);
			var slots = keys[target];
			if (path.EndsWith("/regenerateKeys", StringComparison.OrdinalIgnoreCase))
			{
				var type = JsonNode.Parse(body!)!["keyType"]!.GetValue<string>();
				slots = type == "PrimaryKey" ? (slots.Primary + 1, slots.Secondary) : (slots.Primary, slots.Secondary + 1);
				keys[target] = slots;
				if (path.Contains("admin-unknown"))
					throw new IOException("SECRET response lost after key rotation");
			}
			var primary = "OFFLINE-PRIMARY-" + slots.Primary;
			var secondary = "OFFLINE-SECONDARY-" + slots.Secondary;
			var hub = target.Contains("/eventhubs/") ? target.Split("/eventhubs/")[1].Split('/')[0] : "";
			string Connection(string key) => $"Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName={target.Split('/').Last()};SharedAccessKey={key}" + (hub == "" ? "" : ";EntityPath=" + hub);
			return Reply(HttpStatusCode.OK, new JsonObject { ["primaryKey"] = primary, ["secondaryKey"] = secondary, ["primaryConnectionString"] = Connection(primary), ["secondaryConnectionString"] = Connection(secondary), ["keyName"] = target.Split('/').Last() });
		}
		throw new Exception("Unexpected fixture ARM request");
	}
}
