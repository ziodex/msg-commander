using Azure.Core;
using Azure.Core.Pipeline;
using Azure.ResourceManager;
using MsgCommander.Host;
using System.Net;
using System.Text;
using System.Text.Json.Nodes;

sealed class FixtureEventGridFactory : IEventGridGatewayFactory
{
	public const string Root = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.EventGrid/namespaces/fixture";
	public const string Host = "fixture.westeurope-1.eventgrid.azure.net";
	public async Task<IEventGridGateway> ConnectAsync(ConnectionProfile profile, EventGridManagement management, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		if (profile.Namespace != Host || management.ResourceId != Root)
			throw new OperationException(OperationFailure.InvalidInput, "Offline Event Grid accepts only the fixture namespace.");
		if (management.TenantId == "denied")
			throw new Azure.RequestFailedException(403, "SECRET denied");
		if (management.TenantId == "slow")
		{
			await deviceCode(new("OFFLINE-GRID", MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow.AddMinutes(5))));
			await Task.Delay(10000, cancellation);
		}
		var wire = new EventGridWire { RepeatNext = management.TenantId == "repeat", PullMode = management.TenantId };
		wire.BeforeAsync = async (path, token) => { if (path.EndsWith("/renew")) { await deviceCode(new("OFFLINE-GRID-RENEW", MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow.AddMinutes(5)))); await Task.Delay(10000, token); } };
		return await Connect(wire, cancellation, management.TenantId == "publish-renew" ? new RenewalCredential(deviceCode) : null);
	}
	public static Task<AzureEventGridGateway> Connect(EventGridWire wire, CancellationToken cancellation = default, TokenCredential? publishingCredential = null)
	{
		var client = new HttpClient(wire);
		var options = new ArmClientOptions { Transport = new HttpClientTransport(client), Retry = { MaxRetries = 0 } };
		return AzureEventGridGateway.ConnectAsync(new ArmClient(new Credential(), null, options), Host, Root, cancellation, client, publishingCredential ?? new Credential(), client);
	}
	private sealed class RenewalCredential(Func<DeviceCodeEvent, Task> deviceCode) : TokenCredential
	{
		public override AccessToken GetToken(TokenRequestContext context, CancellationToken cancellation) => throw new NotSupportedException();
		public override async ValueTask<AccessToken> GetTokenAsync(TokenRequestContext context, CancellationToken cancellation)
		{
			await deviceCode(new("OFFLINE-GRID-PUBLISH", MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow.AddMinutes(5))));
			await Task.Delay(10000, cancellation);
			return new("offline-grid-publish", DateTimeOffset.UtcNow.AddHours(1));
		}
	}
	private sealed class Credential : TokenCredential
	{
		public override AccessToken GetToken(TokenRequestContext context, CancellationToken cancellation) => new("offline-grid", DateTimeOffset.UtcNow.AddHours(1));
		public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext context, CancellationToken cancellation) => ValueTask.FromResult(GetToken(context, cancellation));
	}
}
sealed class EventGridWire : HttpMessageHandler
{
	private const string Root = FixtureEventGridFactory.Root;
	public List<(string Method, string Path, string? Body)> Writes { get; } = [];
	public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage?>>? WriteOverride
	{
		get; set;
	}
	public List<(string Topic, string ContentType, string Body)> Publishes { get; } = [];
	public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? PublishOverride
	{
		get; set;
	}
	public string? PrivateFullUrl
	{
		get; set;
	}
	public JsonArray? PrivateAttributes
	{
		get; set;
	}
	public Func<CancellationToken, Task>? BeforeDeliveryRead
	{
		get; set;
	}
	public string PullMode { get; set; } = "fixture";
	public List<(string Action, string Body)> Pulls { get; } = [];
	public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? PullOverride
	{
		get; set;
	}
	private int nextEvent;
	private readonly HashSet<string> pullTokens = [];
	public List<Uri> Requests { get; } = [];
	public Func<string, CancellationToken, Task>? BeforeAsync
	{
		get; set;
	}
	public string? NextLinkOverride
	{
		get; set;
	}
	public string? ReplyOverride
	{
		get; set;
	}
	public bool RepeatNext
	{
		get; set;
	}
	public Dictionary<string, JsonObject> Data { get; } = new(StringComparer.OrdinalIgnoreCase);
	public EventGridWire()
	{
		Seed("", new()
		{
			["provisioningState"] = "Succeeded",
			["topicsConfiguration"] = new JsonObject { ["hostname"] = FixtureEventGridFactory.Host },
			["topicSpacesConfiguration"] = new JsonObject { ["hostname"] = "fixture.mqtt.eventgrid.azure.net" },
			["publicNetworkAccess"] = "Enabled",
			["disableLocalAuth"] = false,
			["minimumTlsVersionAllowed"] = "1.2",
			["primaryKey"] = "SECRET-NAMESPACE"
		});
		Data[Root]["identity"] = new JsonObject { ["type"] = "SystemAssigned, UserAssigned", ["principalId"] = "33333333-3333-3333-3333-333333333333", ["userAssignedIdentities"] = new JsonObject { ["/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/fixture-identity"] = new JsonObject() } };
		Data[Root]["sku"] = new JsonObject { ["name"] = "Standard", ["capacity"] = 1 };
		foreach (var name in new[] { "orders", "archive", "more-orders", "slow", "denied", "renew" })
			Seed("/topics/" + name, new()
			{
				["provisioningState"] = "Succeeded",
				["inputSchema"] = "CloudEventSchemaV1_0",
				["publisherType"] = "Custom",
				["eventRetentionInDays"] = 7
			});
		var filters = JsonNode.Parse("""[{"key":"data.total","operatorType":"NumberInRange","values":[[9007199254740993,9007199254740995]]},{"key":"data.enabled","operatorType":"BoolEquals","value":true},{"key":"subject","operatorType":"StringBeginsWith","values":["orders/","<script>alert(1)</script>"]},{"key":"data.optional","operatorType":"IsNullOrUndefined"}]""")!;
		Seed("/topics/orders/eventSubscriptions/fulfillment", new()
		{
			["provisioningState"] = "Succeeded",
			["eventDeliverySchema"] = "CloudEventSchemaV1_0",
			["filtersConfiguration"] = new JsonObject { ["includedEventTypes"] = new JsonArray("Order.Created", "Order.Updated"), ["filters"] = filters },
			["deliveryConfiguration"] = new JsonObject { ["deliveryMode"] = "Queue", ["queue"] = new JsonObject { ["receiveLockDurationInSeconds"] = 60, ["maxDeliveryCount"] = 10, ["eventTimeToLive"] = "P7D" } }
		});
		Seed("/topics/orders/eventSubscriptions/audit", new()
		{
			["provisioningState"] = "Succeeded",
			["filtersConfiguration"] = new JsonObject { ["includedEventTypes"] = null, ["filters"] = new JsonArray(new JsonObject { ["key"] = "data.future", ["operatorType"] = "FutureOperator", ["values"] = new JsonArray("future"), ["futureSecret"] = "SECRET-FILTER" }) },
			["deliveryConfiguration"] = new JsonObject { ["deliveryMode"] = "Push", ["push"] = new JsonObject { ["maxDeliveryCount"] = 30, ["eventTimeToLive"] = "P1D", ["destination"] = new JsonObject { ["endpointType"] = "WebHook", ["properties"] = new JsonObject { ["endpointUrl"] = "https://example.invalid/?sig=SECRET-URL", ["deliveryAttributeMappings"] = new JsonArray(new JsonObject { ["name"] = "Authorization", ["value"] = "SECRET-HEADER" }) } } } }
		});
		Seed("/topics/orders/eventSubscriptions/extra", new()
		{
			["provisioningState"] = "Succeeded",
			["filtersConfiguration"] = new JsonObject { ["includedEventTypes"] = new JsonArray(), ["filters"] = new JsonArray() }
		});
	}
	public void Seed(string suffix, JsonObject properties)
	{
		var path = Root + suffix;
		Data[path] = new()
		{
			["id"] = path,
			["name"] = path.Split('/')[^1],
			["location"] = "westeurope",
			["properties"] = properties
		};
	}
	protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
	{
		var uri = request.RequestUri!;
		var path = uri.AbsolutePath;
		if (request.Method == HttpMethod.Post && uri.Host == FixtureEventGridFactory.Host && System.Text.RegularExpressions.Regex.IsMatch(path, @"^/topics/[A-Za-z0-9-]{3,50}:publish$"))
		{
			var topic = path.Split('/')[2].Split(':')[0];
			Requests.Add(uri);
			Publishes.Add((topic, request.Content!.Headers.ContentType!.ToString(), await request.Content.ReadAsStringAsync(cancellation)));
			if (PublishOverride is { } publishing)
				return await publishing(request, cancellation);
			if (topic == "publish-denied")
				return Reply(HttpStatusCode.Forbidden, "SECRET denied");
			if (topic == "publish-lost")
				throw new HttpRequestException("SECRET response lost after publishing");
			if (topic == "publish-slow")
				await Task.Delay(10000, cancellation);
			if (topic == "publish-renew")
				await Task.Delay(10000, cancellation);
			return Reply(HttpStatusCode.OK, "{}");
		}
		if (request.Method == HttpMethod.Post && uri.Host == FixtureEventGridFactory.Host && System.Text.RegularExpressions.Regex.IsMatch(path, @"^/topics/[A-Za-z0-9-]{3,50}/eventsubscriptions/[A-Za-z0-9-]{3,50}:(receive|acknowledge|release|reject|renewLock)$"))
		{
			Requests.Add(uri);
			var action = path.Split(':')[1];
			var body = await request.Content!.ReadAsStringAsync(cancellation);
			Pulls.Add((action, body));
			if (PullOverride is { } pull)
				return await pull(request, cancellation);
			if (PullMode == "pull-denied")
				return Reply(HttpStatusCode.Forbidden, "SECRET data denied");
			if (action == "receive")
			{
				if (PullMode == "pull-lost")
					throw new HttpRequestException("SECRET lost receive response");
				if (PullMode == "pull-slow")
					await Task.Delay(10000, cancellation);
				var count = int.Parse(System.Text.RegularExpressions.Regex.Match(uri.Query, @"maxEvents=(\d+)").Groups[1].Value);
				var rows = new JsonArray();
				if (PullMode != "pull-empty")
					for (var i = 0; i < count; i++)
					{
						var n = ++nextEvent;
						var token = "SECRET-LOCK-" + n;
						pullTokens.Add(token);
						var data = PullMode == "pull-large" ? "{\"text\":\"" + new string('x', 80000) + "\"}" : "{\"large\":9007199254740993,\"enabled\":true,\"text\":\"<script>alert(1)</script>\"}";
						var ev = JsonNode.Parse("{\"specversion\":\"1.0\",\"id\":\"event-" + n + "\",\"source\":\"/fixture\",\"type\":\"Order.Created\",\"subject\":\"orders/" + n + "\",\"data\":" + data + "}");
						rows.Add(new JsonObject { ["brokerProperties"] = new JsonObject { ["lockToken"] = token, ["deliveryCount"] = 1 }, ["event"] = ev });
					}
				return Reply(HttpStatusCode.OK, new JsonObject { ["value"] = rows }.ToJsonString());
			}
			if (PullMode == "settle-slow")
				await Task.Delay(10000, cancellation);
			if (PullMode == "settle-lost")
				throw new HttpRequestException("SECRET lost settlement response");
			var tokens = JsonNode.Parse(body)!["lockTokens"]!.AsArray();
			var succeeded = new JsonArray();
			var failed = new JsonArray();
			var index = 0;
			foreach (var t in tokens)
			{
				var token = t!.GetValue<string>();
				if (!pullTokens.Contains(token) || PullMode == "settle-partial" && index++ == 0)
				{
					failed.Add(new JsonObject { ["lockToken"] = token, ["error"] = new JsonObject { ["code"] = "TokenLost", ["message"] = "SECRET broker detail" } });
					continue;
				}
				succeeded.Add(token);
				if (action != "renewLock")
					pullTokens.Remove(token);
			}
			return Reply(HttpStatusCode.OK, new JsonObject { ["succeededLockTokens"] = succeeded, ["failedLockTokens"] = failed }.ToJsonString());
		}
		if (request.Method == HttpMethod.Post && uri.Host == "management.azure.com" && path.StartsWith(Root + "/topics/", StringComparison.OrdinalIgnoreCase) && System.Text.RegularExpressions.Regex.IsMatch(path[Root.Length..], @"^/topics/[A-Za-z0-9-]{3,50}/eventSubscriptions/[A-Za-z0-9-]{3,50}/(getFullUrl|getDeliveryAttributes)$"))
		{
			Requests.Add(uri);
			if (BeforeDeliveryRead is { } beforePrivate)
				await beforePrivate(cancellation);
			if (path.EndsWith("/getFullUrl") && PrivateFullUrl is { } full)
				return Reply(HttpStatusCode.OK, new JsonObject { ["endpointUrl"] = full }.ToJsonString());
			if (path.EndsWith("/getDeliveryAttributes") && PrivateAttributes is { } attrs)
				return Reply(HttpStatusCode.OK, new JsonObject { ["value"] = attrs.DeepClone() }.ToJsonString());
			return Reply(HttpStatusCode.Forbidden, "SECRET private delivery denied");
		}
		if (!new[] { HttpMethod.Get, HttpMethod.Put, HttpMethod.Patch, HttpMethod.Delete }.Contains(request.Method) || uri.Host != "management.azure.com" || (!path.Equals(Root, StringComparison.OrdinalIgnoreCase) && !path.StartsWith(Root + "/", StringComparison.OrdinalIgnoreCase)))
			throw new Exception("Event Grid escaped fixture scope");
		Requests.Add(uri);
		if (BeforeAsync is { } before)
			await before(path, cancellation);
		if (path.Contains("/slow"))
			await Task.Delay(10000, cancellation);
		if (path.Contains("/denied"))
			return Reply(HttpStatusCode.Forbidden, "{\"error\":{\"message\":\"SECRET permission\"}}");
		if (request.Method != HttpMethod.Get)
		{
			var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellation);
			Writes.Add((request.Method.Method, path, body));
			if (path.EndsWith("/write-denied"))
				return Reply(HttpStatusCode.Forbidden, """{"error":{"message":"SECRET permission"}}""");
			if (path.EndsWith("/write-lost") || path.EndsWith("/write-slow") || path.EndsWith("/write-accepted"))
			{
				Seed(path[Root.Length..], JsonNode.Parse(body!)!["properties"]!.DeepClone().AsObject());
				Data[path]["properties"]!["provisioningState"] = path.EndsWith("/write-accepted") ? "Creating" : "Succeeded";
				if (path.EndsWith("/write-lost"))
					throw new HttpRequestException("SECRET lost response after acceptance");
				if (path.EndsWith("/write-slow"))
					await Task.Delay(10000, cancellation);
				if (path.EndsWith("/write-accepted"))
					return Reply(HttpStatusCode.Accepted, "{}");
			}
			if (WriteOverride is { } change && await change(request, cancellation) is { } overrideReply)
				return overrideReply;
			if (path == Root || !System.Text.RegularExpressions.Regex.IsMatch(path[Root.Length..], @"^/topics/[A-Za-z0-9-]{3,50}(?:/eventSubscriptions/[A-Za-z0-9-]{3,50})?$"))
				throw new Exception("Invalid fixture write target");
			if (request.Method == HttpMethod.Delete)
			{
				foreach (var key in Data.Keys.Where(k => k.Equals(path, StringComparison.OrdinalIgnoreCase) || k.StartsWith(path + "/", StringComparison.OrdinalIgnoreCase)).ToArray())
					Data.Remove(key);
				return Reply(HttpStatusCode.NoContent, "");
			}
			var properties = JsonNode.Parse(body!)!["properties"]!.AsObject();
			if (request.Method == HttpMethod.Put)
			{
				var parent = path[..path.LastIndexOf('/')];
				if (parent.EndsWith("/eventSubscriptions") && !Data.ContainsKey(parent[..parent.LastIndexOf('/')]))
					return Reply(HttpStatusCode.NotFound, "{}");
				Seed(path[Root.Length..], properties.DeepClone().AsObject());
			}
			else
			{
				if (!Data.TryGetValue(path, out var prior))
					return Reply(HttpStatusCode.NotFound, "{}");
				foreach (var pair in properties)
					prior["properties"]![pair.Key] = pair.Value?.DeepClone();
			}
			Data[path]["properties"]!["provisioningState"] = "Succeeded";
			return Reply(HttpStatusCode.OK, Data[path].ToJsonString());
		}
		if (ReplyOverride is { } reply)
			return Reply(HttpStatusCode.OK, reply);
		if (Data.TryGetValue(path, out var entity))
			return Reply(HttpStatusCode.OK, entity.ToJsonString());
		if (path.EndsWith("/topics") || path.EndsWith("/eventSubscriptions"))
		{
			var rows = Data.Where(pair => pair.Key.StartsWith(path + "/", StringComparison.OrdinalIgnoreCase) && !pair.Key[(path.Length + 1)..].Contains('/')).Select(pair => pair.Value).ToArray();
			var offset = uri.Query.Contains("page=2") ? 2 : 0;
			var page = new JsonObject { ["value"] = new JsonArray(rows.Skip(offset).Take(offset == 0 ? 2 : 250).Select(r => (JsonNode?)r.DeepClone()).ToArray()) };
			if ((offset == 0 && rows.Length > 2) || RepeatNext)
				page["nextLink"] = NextLinkOverride ?? "https://management.azure.com" + path + "?api-version=" + AzureEventGridGateway.ApiVersion + "&page=2";
			return Reply(HttpStatusCode.OK, page.ToJsonString());
		}
		return Reply(HttpStatusCode.NotFound, "{\"error\":{\"message\":\"SECRET missing\"}}");
	}
	private static HttpResponseMessage Reply(HttpStatusCode code, string json) => new(code) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
}
