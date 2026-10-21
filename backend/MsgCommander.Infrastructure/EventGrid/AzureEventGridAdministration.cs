using MsgCommander.Application.EventGrid.Administration;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Azure;
using Azure.Core;
namespace MsgCommander.Infrastructure.EventGrid;

public sealed partial class AzureEventGridGateway
{
	// ARM does not document conditional ETags here. This is a best-effort fresh-read guard,
	// not a server-side compare-and-swap. Runtime provisioning changes do not invalidate it.
	private static string Revision(JsonObject raw)
	{
		static JsonNode? Canonical(JsonNode? n) => n switch
		{
			JsonObject o => new JsonObject(o.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => new KeyValuePair<string, JsonNode?>(p.Key, Canonical(p.Value)))),
			JsonArray a => new JsonArray(a.Select(Canonical).ToArray()),
			_ => n?.DeepClone()
		};
		var p = raw["properties"]!.DeepClone().AsObject();
		p.Remove("provisioningState");
		return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Canonical(p)!.ToJsonString())));
	}
	private async Task<JsonObject> Raw(EventGridTarget target, CancellationToken cancellation)
	{
		target.Validate();
		if (target.Kind == "namespace")
			throw new OperationException(OperationFailure.InvalidInput, "Namespace administration is not supported.");
		var path = resourceId + target.Suffix();
		var raw = await Request(path, null, cancellation);
		Check(raw, path);
		if (!string.Equals(Text(raw["name"], 50), path.Split('/')[^1], StringComparison.OrdinalIgnoreCase))
			throw Invalid();
		return raw;
	}
	private static IReadOnlyList<EventGridAdminFilter>? EditableFilters(JsonObject p)
	{
		try
		{
			var list = p["filtersConfiguration"]?["filters"]?.AsArray() ?? new();
			if (list.Count > 25)
				return null;
			var result = new List<EventGridAdminFilter>();
			foreach (var item in list)
			{
				var f = item?.AsObject() ?? throw Invalid();
				var key = Text(f["key"], 512);
				var op = Text(f["operatorType"]);
				if (key is null || op is null || !AdvancedFilterOperators.Supported.Contains(op) || f.Any(k => !new[] { "key", "operatorType", "value", "values" }.Contains(k.Key)))
					return null;
				var scalar = op == "BoolEquals" || op.Contains("GreaterThan") || op.Contains("LessThan");
				var empty = op is "IsNotNull" or "IsNullOrUndefined";
				if ((empty && (f.ContainsKey("value") || f.ContainsKey("values"))) || (!empty && (f.ContainsKey(scalar ? "values" : "value") || !f.ContainsKey(scalar ? "value" : "values"))))
					return null;
				var filter = new EventGridAdminFilter(key, op, empty ? "" : f[scalar ? "value" : "values"]?.ToJsonString() ?? "null");
				filter.Definition();
				result.Add(filter);
			}
			EventGridAdministrationRules.ValidateFilters(result);
			return result;
		}
		catch (Exception e) when (e is OperationException or InvalidOperationException or JsonException) { return null; }
	}
	public async Task<EventGridAdminDetails> AdminGetAsync(EventGridTarget target, CancellationToken cancellation)
	{
		var raw = await Raw(target, cancellation);
		var p = raw["properties"]!.AsObject();
		var revision = Revision(raw);
		if (target.Kind == "topic")
			return new(target, revision, p["eventRetentionInDays"]?.GetValue<int>(), null, null);
		var mode = Text(p["deliveryConfiguration"]?["deliveryMode"]);
		if (mode is not ("Queue" or "Push"))
			return new(target, revision, null, null, "Delivery mode is not supported by this editor. Inspection and deletion remain available.");
		var delivery = p["deliveryConfiguration"]![mode.ToLowerInvariant()]?.AsObject();
		var filters = EditableFilters(p);
		var types = p["filtersConfiguration"]?["includedEventTypes"]?.AsArray().Select(t => Text(t, 1024) ?? throw Invalid()).ToArray();
		if (types?.Length > 100)
			throw Invalid();
		var settings = new EventGridSubscriptionSettings(mode, mode == "Queue" && delivery?["receiveLockDurationInSeconds"]?.GetValue<int>() is >= 60 and <= 300 ? delivery["receiveLockDurationInSeconds"]!.GetValue<int>() : null, delivery?["maxDeliveryCount"]?.GetValue<int>() is >= 1 and <= 10 ? delivery["maxDeliveryCount"]!.GetValue<int>() : null, Text(delivery?["eventTimeToLive"], 64), Text(p["expirationTimeUtc"], 64), types, filters);
		var warning = (delivery?["maxDeliveryCount"]?.GetValue<int>() is < 1 or > 10 ? "Unsupported retry count is preserved unchanged unless you enter a supported value (1–10). " : "") + (filters is null ? "Advanced filters contain unsupported fields or values and will be preserved unchanged. " : "") + (mode == "Push" ? "Existing endpoint URLs and header values stay private. Delivery fields are preserved unless explicitly replaced. " : "") + "Delivery mode cannot be changed. Concurrency uses a fresh-read check; Azure does not provide a documented atomic conditional update for these operations.";
		return new(target, revision, null, settings, warning, DeliveryDetails(delivery));
	}
	public Task<string> ChangeAsync(EventGridAdminChange request, Action dispatch, CancellationToken cancellation) =>
		ChangeAsync(EventGridCommands.Prepare(request), dispatch, cancellation);

	public async Task<string> ChangeAsync(EventGridCommand change, Action dispatch, CancellationToken cancellation)
	{
		JsonObject? existing = null;
		try
		{
			existing = await Raw(change.Target, cancellation);
		}
		catch (RequestFailedException e) when (e.Status == 404 && change.Action == "create") { }
		if (change.Action == "create" && existing is not null)
			throw new OperationException(OperationFailure.InvalidInput, "This Event Grid resource already exists. Refresh and choose Edit; it was not overwritten.");
		if (change.Action != "create" && (existing is null || Revision(existing) != change.ExpectedRevision))
			throw new OperationException(OperationFailure.InvalidInput, "Event Grid settings changed since review. Reload the editor before submitting again.");
		if (existing?["properties"]?["provisioningState"] is { } state && state.GetValue<string>() is not ("Succeeded" or "Failed" or "Canceled"))
			throw new OperationException(OperationFailure.InvalidInput, "Azure is still provisioning this resource. Refresh and wait before another change.");
		JsonObject? body = null;
		if (change.Action != "delete")
		{
			var properties = new JsonObject();
			if (change is CreateEventGridTopic createTopic)
			{
				properties["eventRetentionInDays"] = createTopic.RetentionDays;
				properties["inputSchema"] = "CloudEventSchemaV1_0";
				properties["publisherType"] = "Custom";
			}
			else if (change is UpdateEventGridTopic updateTopic)
			{
				properties["eventRetentionInDays"] = updateTopic.RetentionDays;
			}
			else if (change is EventGridSubscriptionCommand subscription)
			{
				var settings = subscription.Settings;
				var ttl = settings.Validate();
				var parent = await Raw(new("topic", change.Target.TopicName, null), cancellation);
				var retention = parent["properties"]?["eventRetentionInDays"]?.GetValue<int>() ?? throw Invalid();
				if (ttl > TimeSpan.FromDays(retention))
					throw new OperationException(OperationFailure.InvalidInput, "Subscription TTL cannot exceed the parent topic retention. No change was sent.");
				var old = existing?["properties"]?.AsObject();
				var delivery = old?["deliveryConfiguration"]?.DeepClone().AsObject() ?? new JsonObject { ["deliveryMode"] = settings.DeliveryMode };
				if (Text(delivery["deliveryMode"]) != settings.DeliveryMode)
					throw new OperationException(OperationFailure.InvalidInput, "An existing subscription's delivery mode cannot be changed.");
				var part = delivery[settings.DeliveryMode.ToLowerInvariant()]?.AsObject() ?? new JsonObject();
				if (settings.ReceiveLockDurationInSeconds is { } duration)
					part["receiveLockDurationInSeconds"] = duration;
				if (settings.MaxDeliveryCount is { } count)
					part["maxDeliveryCount"] = count;
				if (settings.EventTimeToLive is { } value)
					part["eventTimeToLive"] = value;
				await ConfigureDelivery(part, subscription, cancellation);
				delivery[settings.DeliveryMode.ToLowerInvariant()] = part.Parent is null ? part : part.DeepClone();
				if (change.Action == "create" || !JsonNode.DeepEquals(delivery, old?["deliveryConfiguration"]))
				{
					if (settings.DeliveryMode == "Push")
					{
						var outgoing = delivery[settings.DeliveryMode.ToLowerInvariant()]!.AsObject();
						var privateDestination = (outgoing["deliveryWithResourceIdentity"]?["destination"] ?? outgoing["destination"])?.AsObject();
						if (privateDestination is not null)
							await HydrateDelivery(privateDestination, subscription, cancellation);
						EnsureWritableDelivery(outgoing);
					}
					properties["deliveryConfiguration"] = delivery;
				}
				properties["expirationTimeUtc"] = settings.ExpirationTimeUtc;
				var filters = old?["filtersConfiguration"]?.DeepClone().AsObject() ?? new JsonObject();
				filters["includedEventTypes"] = settings.IncludedEventTypes is null ? null : new JsonArray(settings.IncludedEventTypes.Select(t => (JsonNode?)JsonValue.Create(t)).ToArray());
				if (settings.Filters is not null)
					filters["filters"] = new JsonArray(settings.Filters.Select(f => (JsonNode?)f.Definition()).ToArray());
				properties["filtersConfiguration"] = filters;
				if (change.Action == "create")
					properties["eventDeliverySchema"] = "CloudEventSchemaV1_0";
			}
			body = new()
			{
				["properties"] = properties
			};
		}
		cancellation.ThrowIfCancellationRequested();
		using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
		deadline.CancelAfter(TimeSpan.FromMinutes(5));
		using var message = transport.RequestPipeline.CreateMessage();
		message.BufferResponse = false;
		message.Request.Method = change.Action switch
		{
			"create" => RequestMethod.Put,
			"update" => RequestMethod.Patch,
			_ => RequestMethod.Delete
		};
		message.Request.Uri.Reset(new Uri("https://management.azure.com" + resourceId + change.Target.Suffix() + "?api-version=" + ApiVersion));
		if (body is not null)
		{
			message.Request.Headers.Add("Content-Type", "application/json");
			message.Request.Content = RequestContent.Create(Encoding.UTF8.GetBytes(body.ToJsonString()));
		}
		dispatch();
		await transport.RequestPipeline.SendAsync(message, deadline.Token);
		var status = message.Response.Status;
		if (status >= 400)
			throw new RequestFailedException(status, "Event Grid change rejected.");
		if (status is not (200 or 201 or 202 or 204))
			throw new IOException("Unexpected Event Grid write response.");
		if (status == 202)
			return "accepted";
		if (change.Action == "delete")
			return "confirmed";
		// The response already acknowledges acceptance. A lost/cancelled response body must
		// not turn that into a failed write or trigger a retry. Never follow provider poll URLs.
		try
		{
			using var output = new MemoryStream();
			var stream = message.Response.ContentStream;
			if (stream is null)
				return "accepted";
			var buffer = new byte[16384];
			while (true)
			{
				var read = await stream.ReadAsync(buffer, deadline.Token);
				if (read == 0)
					break;
				if (output.Length + read > 2 * 1024 * 1024)
					return "accepted";
				output.Write(buffer, 0, read);
			}
			using var doc = JsonDocument.Parse(output.ToArray(), new()
			{
				MaxDepth = 32
			});
			var raw = doc.RootElement;
			if (!raw.TryGetProperty("id", out var rid) || !string.Equals(rid.GetString(), resourceId + change.Target.Suffix(), StringComparison.OrdinalIgnoreCase) || !raw.TryGetProperty("properties", out var props) || !props.TryGetProperty("provisioningState", out var provisioning))
				return "accepted";
			return provisioning.GetString() switch
			{
				"Succeeded" => "confirmed",
				"Failed" or "Canceled" => "failed",
				_ => "accepted"
			};
		}
		catch (Exception) { return "accepted"; }
	}
}
