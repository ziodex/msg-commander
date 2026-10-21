using System.Net;
using System.Text;
using System.Text.Json;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.ResourceManager;
using MsgCommander.Host;

sealed class FixtureAuthorization : IAuthorizationGateway
{
	private readonly AzureAuthorizationGateway gateway;
	public AuthorizationWire Wire
	{
		get;
	}
	private readonly Func<DeviceCodeEvent, Task>? deviceCode;
	public FixtureAuthorization(string resourceId, Func<DeviceCodeEvent, Task>? deviceCode = null)
	{
		this.deviceCode = deviceCode;
		Wire = new(resourceId);
		var options = new ArmClientOptions { Transport = new HttpClientTransport(new HttpClient(Wire)), Retry = { MaxRetries = 0 }, Diagnostics = { IsLoggingEnabled = false } };
		gateway = new(new ArmClient(new FixtureCredential(), null, options), resourceId);
	}
	public Task<AuthorizationPage> ListAsync(AuthorizationTarget target, CancellationToken cancellation) => gateway.ListAsync(target, cancellation);
	public async Task<AuthorizationRule> GetAsync(AuthorizationTarget target, string name, CancellationToken cancellation)
	{
		if (name == "reauth" && deviceCode is not null)
			await deviceCode(new("OFFLINE-REFRESH", MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow.AddMinutes(5))));
		return await gateway.GetAsync(target, name, cancellation);
	}
	public Task<AuthorizationKey> KeyAsync(AuthorizationTarget target, string name, string keyType, CancellationToken cancellation) => gateway.KeyAsync(target, name, keyType, cancellation);
	public Task ChangeAsync(string action, AuthorizationTarget target, string name, IReadOnlyList<string>? rights, string? expectedRevision, string? keyType, Action dispatching, CancellationToken cancellation) => gateway.ChangeAsync(action, target, name, rights, expectedRevision, keyType, dispatching, cancellation);
	sealed class FixtureCredential : TokenCredential
	{
		public override AccessToken GetToken(TokenRequestContext context, CancellationToken cancellation)
		{
			if (!context.Scopes.All(s => s == "https://management.azure.com//.default"))
				throw new Exception("Unexpected token audience: " + string.Join(",", context.Scopes));
			return new("offline-token", DateTimeOffset.UtcNow.AddHours(1));
		}
		public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext context, CancellationToken cancellation) => ValueTask.FromResult(GetToken(context, cancellation));
	}
}

sealed class AuthorizationWire(string resourceId) : HttpMessageHandler
{
	public sealed class Policy(string[] rights)
	{
		public string[] Rights = rights;
		public string Primary = "fixture-primary-secret";
		public string Secondary = "fixture-secondary-secret";
	}
	public Dictionary<string, Policy> Policies
	{
		get;
	} = new(StringComparer.OrdinalIgnoreCase)
	{
		[resourceId + "/authorizationRules/RootManageSharedAccessKey"] = new(["Manage", "Send", "Listen"]),
		[resourceId + "/queues/orders/authorizationRules/sender"] = new(["Send"]),
		[resourceId + "/topics/order-events/authorizationRules/subscriber"] = new(["Listen"]),
	};
	public List<(string Method, string Path, string? Body)> Requests = [];
	public int Rotations, KeyReads;
	public bool Paginate;
	private object Project(string path, Policy policy) => new { id = path, name = path.Split('/').Last(), type = "Microsoft.ServiceBus/namespaces/authorizationRules", properties = new { rights = policy.Rights } };
	private static HttpResponseMessage Json(object value, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };
	protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
	{
		if (request.RequestUri!.Host != "management.azure.com")
			throw new Exception("Unexpected ARM endpoint");
		if (request.RequestUri.AbsolutePath.Contains("nested") && (!request.RequestUri.AbsolutePath.Contains("%2F", StringComparison.OrdinalIgnoreCase) || request.RequestUri.AbsolutePath.Contains("%252F", StringComparison.OrdinalIgnoreCase)))
			throw new Exception("Nested names must be escaped exactly once");
		var path = Uri.UnescapeDataString(request.RequestUri.AbsolutePath);
		if (!path.StartsWith(resourceId + "/", StringComparison.OrdinalIgnoreCase))
			throw new Exception("Escaped namespace scope");
		var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellation);
		Requests.Add((request.Method.Method, path, body));
		if (request.Method == HttpMethod.Get && path.EndsWith("/authorizationRules", StringComparison.OrdinalIgnoreCase))
		{
			var items = Policies.Where(p => p.Key[..p.Key.LastIndexOf('/')].Equals(path, StringComparison.OrdinalIgnoreCase)).ToArray();
			if (Paginate && !request.RequestUri.Query.Contains("fixturePage=2"))
				return Json(new
				{
					value = items.Take(1).Select(p => Project(p.Key, p.Value)),
					nextLink = $"https://management.azure.com{request.RequestUri.AbsolutePath}?api-version=2026-01-01&fixturePage=2"
				});
			return Json(new
			{
				value = (Paginate ? items.Skip(1) : items).Select(p => Project(p.Key, p.Value))
			});
		}
		var method = path.Split('/').Last();
		var rulePath = method is "listKeys" or "regenerateKeys" ? path[..path.LastIndexOf('/')] : path;
		var name = rulePath.Split('/').Last();
		if (name == "denied")
			return Json(new
			{
				error = new
				{
					code = "Forbidden",
					message = "SECRET server detail"
				}
			}, HttpStatusCode.Forbidden);
		Policies.TryGetValue(rulePath, out var policy);
		if (request.Method == HttpMethod.Get)
			return policy is null ? Missing() : Json(Project(rulePath, policy));
		if (request.Method == HttpMethod.Put)
		{
			var rights = JsonDocument.Parse(body!).RootElement.GetProperty("properties").GetProperty("rights").EnumerateArray().Select(r => r.GetString()!).ToArray();
			if (policy is null)
				Policies[rulePath] = policy = new(rights);
			else
				policy.Rights = rights;
			return Json(Project(rulePath, policy));
		}
		if (policy is null)
			return Missing();
		if (request.Method == HttpMethod.Delete)
		{
			Policies.Remove(rulePath);
			return new(HttpStatusCode.OK);
		}
		if (method == "regenerateKeys")
		{
			var slot = JsonDocument.Parse(body!).RootElement.GetProperty("keyType").GetString();
			Rotations++;
			if (slot == "PrimaryKey")
				policy.Primary = $"fixture-primary-rotated-{Rotations}";
			else if (slot == "SecondaryKey")
				policy.Secondary = $"fixture-secondary-rotated-{Rotations}";
			else
				throw new Exception("Invalid key slot in SDK request");
			if (name == "uncertain")
				throw new HttpRequestException("SECRET lost acknowledgement after rotation");
			if (name == "slow")
				await Task.Delay(10000, cancellation);
			if (name == "throttled")
				return Json(new
				{
					error = new
					{
						code = "TooManyRequests",
						message = "SECRET throttle"
					}
				}, HttpStatusCode.TooManyRequests);
		}
		else if (method == "listKeys")
			KeyReads++;
		else
			throw new Exception("Unexpected SDK request");
		string Connection(string key) => $"Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName={name};SharedAccessKey={key}" + (rulePath.Contains("/queues/") || rulePath.Contains("/topics/") ? $";EntityPath={rulePath[(resourceId.Length + 1)..].Split("/authorizationRules/")[0].Split('/', 2)[1]}" : "");
		return Json(new
		{
			primaryKey = policy.Primary,
			secondaryKey = policy.Secondary,
			primaryConnectionString = Connection(policy.Primary),
			secondaryConnectionString = Connection(policy.Secondary),
			keyName = name
		});
	}
	private static HttpResponseMessage Missing() => Json(new { error = new { code = "NotFound", message = "SECRET absent" } }, HttpStatusCode.NotFound);
}
