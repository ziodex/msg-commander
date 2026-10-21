using System.Text.Json;
using System.Text.Json.Nodes;
using Azure;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.ResourceManager;
namespace MsgCommander.Infrastructure.EventGrid;

public sealed class AzureEventGridGatewayFactory : IEventGridGatewayFactory
{
	public async Task<IEventGridGateway> ConnectAsync(ConnectionProfile profile, EventGridManagement management, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		management.Validate(profile.Namespace);
		if (profile.Service != "event-grid" || profile.Auth != "device-code")
			throw new OperationException(OperationFailure.InvalidInput, "Use an Event Grid Entra profile for resource discovery.");
		var credential = MsgCommander.Infrastructure.Authentication.AzureDeviceCodeCredential.Create(management.TenantId, management.ClientId, deviceCode);
		var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromMinutes(5) };
		var options = new ArmClientOptions { Environment = ArmEnvironment.AzurePublicCloud, Transport = new HttpClientTransport(http), Retry = { MaxRetries = 0, NetworkTimeout = TimeSpan.FromMinutes(5) }, Diagnostics = { IsLoggingContentEnabled = false } };
		try
		{
			return await AzureEventGridGateway.ConnectAsync(new ArmClient(credential, null, options), profile.Namespace, management.ResourceId, cancellation, http, credential, http);
		}
		catch { http.Dispose(); throw; }
	}
}
public sealed partial class AzureEventGridGateway : IEventGridGateway
{
	public const string ApiVersion = "2025-02-15";
	private sealed class Transport(ArmClient client, ResourceIdentifier id) : ArmResource(client, id)
	{
		public HttpPipeline RequestPipeline => Pipeline;
	}
	private readonly Transport transport; private readonly string resourceId; private readonly IDisposable? owner;
	public string Location { get; private set; } = "";
	private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true };
	private AzureEventGridGateway(ArmClient client, string resourceId, IDisposable? owner)
	{
		transport = new(client, new ResourceIdentifier(resourceId));
		this.resourceId = resourceId;
		this.owner = owner;
	}
	public static async Task<AzureEventGridGateway> ConnectAsync(ArmClient client, string host, string resourceId, CancellationToken cancellation, IDisposable? owner = null, TokenCredential? publishingCredential = null, HttpClient? publishingHttp = null)
	{
		// Validate independently of the caller, including test and future SDK entry points.
		new EventGridManagement(resourceId, "validation", Guid.Empty.ToString()).Validate(host);
		var gateway = new AzureEventGridGateway(client, resourceId, owner);
		var raw = await gateway.Request(resourceId, null, cancellation);
		Check(raw, resourceId);
		if (!string.Equals(Text(raw["properties"]?["topicsConfiguration"]?["hostname"], 253), host, StringComparison.OrdinalIgnoreCase))
			throw new OperationException(OperationFailure.InvalidInput, "Azure's HTTP topics hostname does not match this Event Grid profile. Use the namespace HTTP endpoint, not MQTT or a custom topic endpoint.");
		gateway.publishingCredential = publishingCredential;
		gateway.publishingHttp = publishingHttp;
		gateway.publishingHost = host;
		gateway.Location = Text(raw["location"], 128) ?? throw Invalid();
		return gateway;
	}
	private static OperationException Invalid() => new(OperationFailure.OperationBlocked, "Event Grid returned invalid or oversized resource metadata. Refresh explicitly; no partial page was displayed.");
	private static string? Text(JsonNode? node, int max = 128)
	{
		if (node is null)
			return null;
		var value = node.GetValue<string>();
		if (value.Length > max || value.Any(char.IsControl))
			throw Invalid();
		return value;
	}
	private static void Check(JsonObject raw, string expected)
	{
		if (!string.Equals(Text(raw["id"], 1024), expected, StringComparison.OrdinalIgnoreCase))
			throw new OperationException(OperationFailure.OperationBlocked, "Azure returned an Event Grid resource outside the selected parent.");
	}
	private static Uri Continuation(Uri uri, string? continuation)
	{
		if (continuation is not null)
		{
			if (continuation.Length > 8192 || !Uri.TryCreate(continuation, UriKind.Absolute, out var next) || next.Scheme != "https" || next.Host != "management.azure.com" || !next.IsDefaultPort || next.UserInfo != "" || next.Fragment != "" || !string.Equals(next.AbsolutePath, uri.AbsolutePath, StringComparison.OrdinalIgnoreCase))
				throw new OperationException(OperationFailure.OperationBlocked, "Event Grid continuation escaped the selected resource list.");
			var versions = next.Query.TrimStart('?').Split('&').Select(p => p.Split('=', 2)).Where(p => Uri.UnescapeDataString(p[0]) == "api-version").ToArray();
			if (versions.Length != 1 || versions[0].Length != 2 || Uri.UnescapeDataString(versions[0][1]) != ApiVersion)
				throw new OperationException(OperationFailure.OperationBlocked, "Event Grid continuation changed the API version.");
			return next;
		}
		return uri;
	}
	private async Task<JsonObject> Request(string path, string? continuation, CancellationToken cancellation, bool deliveryRead = false)
	{
		var uri = new Uri("https://management.azure.com" + path + "?api-version=" + ApiVersion);
		uri = Continuation(uri, continuation);
		using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
		deadline.CancelAfter(TimeSpan.FromMinutes(5));
		try
		{
			using var message = transport.RequestPipeline.CreateMessage();
			message.BufferResponse = false;
			message.Request.Method = deliveryRead ? RequestMethod.Post : RequestMethod.Get;
			message.Request.Uri.Reset(uri);
			await transport.RequestPipeline.SendAsync(message, deadline.Token);
			if (message.Response.Status >= 400)
				throw new RequestFailedException(message.Response.Status, "Event Grid resource read rejected.");
			if (message.Response.Status != 200)
				throw Invalid();
			using var output = new MemoryStream();
			var stream = message.Response.ContentStream ?? throw Invalid();
			var buffer = new byte[65536];
			while (true)
			{
				var read = await stream.ReadAsync(buffer, deadline.Token);
				if (read == 0)
					break;
				if (output.Length + read > 2 * 1024 * 1024)
					throw Invalid();
				output.Write(buffer, 0, read);
			}
			using var doc = JsonDocument.Parse(output.ToArray(), new()
			{
				MaxDepth = 32
			});
			static void Unique(JsonElement node)
			{
				if (node.ValueKind == JsonValueKind.Object)
				{
					var seen = new HashSet<string>(StringComparer.Ordinal);
					foreach (var p in node.EnumerateObject())
					{
						if (!seen.Add(p.Name))
							throw Invalid();
						Unique(p.Value);
					}
				}
				else if (node.ValueKind == JsonValueKind.Array)
					foreach (var v in node.EnumerateArray())
						Unique(v);
			}
			Unique(doc.RootElement);
			return JsonNode.Parse(doc.RootElement.GetRawText())!.AsObject();
		}
		catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { throw new OperationException(OperationFailure.TransportUnavailable, "Event Grid resource read timed out. Retry explicitly."); }
		catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException or HttpRequestException) { throw new OperationException(OperationFailure.TransportUnavailable, "Could not read Event Grid resource metadata. Check connectivity and refresh explicitly."); }
	}
	public async Task<EventGridPage> ListAsync(EventGridTarget parent, string? continuation, CancellationToken cancellation)
	{
		parent.Validate();
		if (parent.Kind == "subscription")
			throw new OperationException(OperationFailure.InvalidInput, "List topics from a namespace or subscriptions from a topic.");
		var prefix = resourceId + parent.Suffix() + (parent.Kind == "namespace" ? "/topics" : "/eventSubscriptions");
		var raw = await Request(prefix, continuation, cancellation);
		var rows = raw["value"]?.AsArray() ?? throw Invalid();
		if (rows.Count > 250)
			throw Invalid();
		var items = new List<EventGridItem>();
		var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
		foreach (var row in rows)
		{
			var obj = row?.AsObject() ?? throw Invalid();
			var name = Text(obj["name"], 50);
			if (!EventGridAddress.IsName(name) || !names.Add(name!))
				throw Invalid();
			Check(obj, prefix + "/" + name);
			var target = parent.Kind == "namespace" ? new EventGridTarget("topic", name, null) : new EventGridTarget("subscription", parent.TopicName, name);
			var p = obj["properties"]?.AsObject() ?? throw Invalid();
			items.Add(new(target, name!, Text(p["provisioningState"]), Text(p["deliveryConfiguration"]?["deliveryMode"]), Text(p["inputSchema"])));
		}
		var nextLink = Text(raw["nextLink"], 8192);
		Continuation(new Uri("https://management.azure.com" + prefix + "?api-version=" + ApiVersion), nextLink);
		return new(items, nextLink);
	}
	public async Task<EventGridDetails> GetAsync(EventGridTarget target, CancellationToken cancellation)
	{
		target.Validate();
		var path = resourceId + target.Suffix();
		var raw = await Request(path, null, cancellation);
		Check(raw, path);
		if (!string.Equals(Text(raw["name"], 50), path.Split('/')[^1], StringComparison.OrdinalIgnoreCase))
			throw Invalid();
		return Project(target, path, raw);
	}
	internal static EventGridDetails Project(EventGridTarget target, string path, JsonObject raw)
	{
		var p = raw["properties"]?.AsObject() ?? throw Invalid();
		var values = new List<PropertyValue>();
		void Add(string label, JsonNode? node)
		{
			if (node is null)
				return;
			var value = node.ToJsonString();
			if (value.Length > 4096)
				throw Invalid();
			values.Add(MsgCommander.Application.Common.DisplayValues.Property(label, node is JsonValue scalar && scalar.TryGetValue<string>(out var text) ? text : value));
		}
		Add("Provisioning state", p["provisioningState"]);
		Add("Location", raw["location"]);
		if (target.Kind == "namespace")
		{
			Add("HTTP topics hostname", p["topicsConfiguration"]?["hostname"]);
			Add("SKU", raw["sku"]?["name"]);
			Add("Capacity", raw["sku"]?["capacity"]);
			Add("Public network access", p["publicNetworkAccess"]);
			Add("Local authentication disabled", p["disableLocalAuth"]);
			Add("Minimum TLS", p["minimumTlsVersionAllowed"]);
		}
		else if (target.Kind == "topic")
		{
			Add("Input schema", p["inputSchema"]);
			Add("Publisher type", p["publisherType"]);
			Add("Retention (days)", p["eventRetentionInDays"]);
		}
		else
		{
			Add("Delivery mode", p["deliveryConfiguration"]?["deliveryMode"]);
			Add("Event delivery schema", p["eventDeliverySchema"]);
		}
		EventGridFilters? filters = null;
		string? delivery = null;
		var warnings = new List<string>();
		if (target.Kind == "subscription")
		{
			if (p["filtersConfiguration"] is JsonObject config)
			{
				IReadOnlyList<string>? types = config["includedEventTypes"] is null ? null : config["includedEventTypes"]!.AsArray().Select(n => Text(n, 1024) ?? throw Invalid()).ToArray();
				if (types?.Count > 100)
					throw Invalid();
				var list = config["filters"]?.AsArray() ?? new JsonArray();
				if (list.Count > 100)
					throw Invalid();
				var projected = new List<EventGridFilter>();
				var operators = new[] { "BoolEquals", "IsNotNull", "IsNullOrUndefined", "NumberGreaterThan", "NumberGreaterThanOrEquals", "NumberIn", "NumberInRange", "NumberLessThan", "NumberLessThanOrEquals", "NumberNotIn", "NumberNotInRange", "StringBeginsWith", "StringContains", "StringEndsWith", "StringIn", "StringNotBeginsWith", "StringNotContains", "StringNotEndsWith", "StringNotIn" };
				foreach (var filter in list)
				{
					var f = filter?.AsObject() ?? throw Invalid();
					var key = Text(f["key"], 1024);
					var op = Text(f["operatorType"], 128);
					var known = operators.Contains(op);
					if (!known)
						warnings.Add("An unknown filter operator is shown for inspection. Filters are not evaluated or edited locally.");
					var safe = new JsonObject();
					foreach (var name in new[] { "key", "operatorType", "value", "values" })
						if (f.ContainsKey(name))
							safe[name] = f[name]?.DeepClone();
					if (f.Any(pair => !new[] { "key", "operatorType", "value", "values" }.Contains(pair.Key)))
						warnings.Add("Additional filter fields were omitted from the supported projection.");
					var json = safe.ToJsonString(Pretty);
					if (System.Text.Encoding.UTF8.GetByteCount(json) > 65536)
						throw Invalid();
					projected.Add(new(key, op, known, json));
				}
				filters = new(types, projected);
			}
			if (p["deliveryConfiguration"] is JsonObject configDelivery)
			{
				var safe = new JsonObject { ["deliveryMode"] = configDelivery["deliveryMode"]?.DeepClone() };
				foreach (var mode in new[] { "queue", "push" })
					if (configDelivery[mode] is JsonObject settings)
					{
						var part = new JsonObject();
						foreach (var field in new[] { "receiveLockDurationInSeconds", "maxDeliveryCount", "eventTimeToLive" })
							if (settings.ContainsKey(field))
								part[field] = settings[field]?.DeepClone();
						// Destination URLs, headers, identity details and credentials are not inspected as raw ARM JSON.
						if (mode == "push")
						{
							var destination = settings["destination"] ?? settings["deliveryWithResourceIdentity"]?["destination"];
							if (destination is JsonObject d)
							{
								part["destinationType"] = Text(d["endpointType"]);
								var rid = Text(d["properties"]?["resourceId"], 1024);
								if (rid is not null && rid.StartsWith("/subscriptions/", StringComparison.OrdinalIgnoreCase))
									part["destinationResourceId"] = rid;
							}
							warnings.Add("Push endpoint URLs, delivery headers and authentication details are omitted.");
						}
						if (settings["deadLetterDestinationWithResourceIdentity"]?["deadLetterDestination"] is JsonObject dead)
						{
							part["deadLetterDestinationType"] = Text(dead["endpointType"]);
							var rid = Text(dead["properties"]?["resourceId"], 1024);
							if (rid is not null && rid.StartsWith("/subscriptions/", StringComparison.OrdinalIgnoreCase))
								part["deadLetterResourceId"] = rid;
						}
						safe[mode] = part;
					}
				delivery = safe.ToJsonString(Pretty);
				if (System.Text.Encoding.UTF8.GetByteCount(delivery) > 131072)
					throw Invalid();
			}
		}
		return new(target, path, Text(raw["name"], 50) ?? throw Invalid(), values, filters, delivery, warnings.Count == 0 ? null : string.Join(" ", warnings.Distinct()), MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow));
	}
	public ValueTask DisposeAsync()
	{
		owner?.Dispose();
		return ValueTask.CompletedTask;
	}
}
