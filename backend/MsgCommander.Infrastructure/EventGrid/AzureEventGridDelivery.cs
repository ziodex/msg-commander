using MsgCommander.Application.EventGrid.Administration;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
namespace MsgCommander.Infrastructure.EventGrid;

public sealed partial class AzureEventGridGateway
{
	private static EventGridIdentity? IdentityDetails(JsonNode? value)
	{
		var type = Text(value?["type"]);
		var id = Text(value?["userAssignedIdentity"], 1024);
		var identity = type is "SystemAssigned" or "UserAssigned" ? new EventGridIdentity(type, id) : null;
		try
		{
			identity?.Validate(false);
			return identity;
		}
		catch (OperationException) { return null; }
	}
	private static EventGridDeliveryDetails DeliveryDetails(JsonObject? part)
	{
		var bound = part?["deliveryWithResourceIdentity"];
		var destination = bound?["destination"] ?? part?["destination"];
		var headers = new List<EventGridHeaderDetails>();
		if (destination?["properties"]?["deliveryAttributeMappings"] is JsonArray mappings)
			foreach (var item in mappings.Take(10))
			{
				// Only labels cross IPC, including for non-secret static values and future mappings.
				headers.Add(new(Text(item?["name"], 64) ?? "(unsupported)", Text(item?["type"], 64) ?? "Unsupported", item?["properties"]?["isSecret"]?.GetValue<bool>() ?? (Text(item?["type"], 64) != "Dynamic")));
			}
		var dead = part?["deadLetterDestinationWithResourceIdentity"];
		var dp = dead?["deadLetterDestination"]?["properties"];
		return new(Text(destination?["endpointType"], 100), Text(destination?["properties"]?["resourceId"], 1024), bound is null ? new("None", null) : IdentityDetails(bound["identity"]), headers, dead is null ? null : new(Text(dp?["resourceId"], 1024), Text(dp?["blobContainerName"], 63), IdentityDetails(dead["identity"])));
	}
	private static bool MaskedHeader(JsonNode? h) => Text(h?["type"], 64) == "Static" && (h?["properties"]?["value"] is null || h?["properties"]?["isSecret"]?.GetValue<bool>() == true && Regex.IsMatch(h["properties"]!["value"]!.GetValue<string>(), @"^\*+$"));
	private async Task HydrateDelivery(JsonObject destination, EventGridSubscriptionCommand change, CancellationToken cancellation)
	{
		if (change.Action != "update" || change.Destination is not null)
			return;
		var p = destination["properties"]?.AsObject() ?? throw Invalid();
		var hydrated = false;
		try
		{
			if (Text(destination["endpointType"]) == "WebHook" && (Text(p["endpointUrl"], 8192) is not { } url || url.Contains("***")))
			{
				var raw = await Request(resourceId + change.Target.Suffix() + "/getFullUrl", null, cancellation, true);
				var full = Text(raw["endpointUrl"], 8192) ?? throw Invalid();
				new EventGridDestination("WebHook", full, null, null).Definition();
				if (full.Contains("***"))
					throw Invalid();
				p["endpointUrl"] = full;
				hydrated = true;
			}
			if (change.Delivery?.Headers is null && p["deliveryAttributeMappings"] is JsonArray mappings && mappings.Any(MaskedHeader))
			{
				var raw = await Request(resourceId + change.Target.Suffix() + "/getDeliveryAttributes", null, cancellation, true);
				var attributes = raw["value"]?.AsArray() ?? throw Invalid();
				if (attributes.Count > 10)
					throw Invalid();
				var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
				foreach (var h in attributes)
					if (!names.Add(Text(h?["name"], 64) ?? throw Invalid()))
						throw Invalid();
				if (attributes.Count != mappings.Count)
					throw EventGridDeliveryRules.Bad("Delivery headers changed during review. Reload the editor");
				foreach (var h in mappings.Where(MaskedHeader))
				{
					var full = attributes.SingleOrDefault(v => string.Equals(Text(v?["name"], 64), Text(h?["name"], 64), StringComparison.OrdinalIgnoreCase));
					if (full is null || Text(full["type"], 64) != "Static" || MaskedHeader(full))
						throw Invalid();
					var properties = h?["properties"]?.AsObject() ?? throw Invalid();
					properties["value"] = Text(full["properties"]?["value"], 4096) ?? throw Invalid();
				}
				hydrated = true;
			}
			if (hydrated && Revision(await Raw(change.Target, cancellation)) != change.ExpectedRevision)
				throw EventGridDeliveryRules.Bad("Event Grid settings changed during private delivery reads. Reload the editor");
		}
		catch (Azure.RequestFailedException) { throw EventGridDeliveryRules.Bad("Azure denied private delivery reads. Replace the destination URL and headers explicitly, or grant the selected subscription's getFullUrl/getDeliveryAttributes permissions"); }
	}
	private static void EnsureWritableDelivery(JsonObject part)
	{
		var destination = part["deliveryWithResourceIdentity"]?["destination"] ?? part["destination"];
		if (destination is null)
			return;
		var properties = destination["properties"];
		if (Text(destination["endpointType"]) == "WebHook" && (Text(properties?["endpointUrl"], 8192) is not { } url || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https" || url.Contains("***")))
			throw EventGridDeliveryRules.Bad("Azure withheld the existing webhook URL. Replace the destination with its full URL before changing delivery settings");
		if (properties?["deliveryAttributeMappings"] is JsonArray mappings && mappings.Any(MaskedHeader))
			throw EventGridDeliveryRules.Bad("Azure withheld a secret header. Replace the headers explicitly before changing delivery settings");
	}
	private async Task RequireIdentity(EventGridIdentity? identity, CancellationToken cancellation)
	{
		if (identity is null || identity.Type == "None")
			return;
		identity.Validate(false);
		var ns = await Request(resourceId, null, cancellation);
		Check(ns, resourceId);
		var configured = ns["identity"];
		var type = Text(configured?["type"]);
		if (identity.Type == "SystemAssigned" ? type?.Split(',').Any(t => t.Trim() == "SystemAssigned") != true : (type?.Split(',').Any(t => t.Trim() == "UserAssigned") != true || configured?["userAssignedIdentities"]?.AsObject().Any(p => string.Equals(p.Key, identity.UserAssignedIdentity, StringComparison.OrdinalIgnoreCase)) != true))
			throw EventGridDeliveryRules.Bad("This managed identity is not configured on the connected namespace. Configure the namespace identity and destination RBAC, then reload");
	}
	private async Task ConfigureDelivery(JsonObject part, EventGridSubscriptionCommand change, CancellationToken cancellation)
	{
		var edit = change.Delivery;
		var push = change.Settings.DeliveryMode == "Push";
		if (edit is null && change.Destination is null)
			return;
		var bound = part["deliveryWithResourceIdentity"]?.AsObject();
		var destination = change.Destination?.Definition() ?? (bound?["destination"] ?? part["destination"])?.DeepClone().AsObject();
		var touchesDestination = change.Destination is not null || edit?.Identity is not null || edit?.Headers is not null || edit?.WebhookAuthentication is not null;
		if (push && touchesDestination)
		{
			if (destination is null)
				throw EventGridDeliveryRules.Bad("The existing destination cannot be edited; supply a replacement");
			await HydrateDelivery(destination, change, cancellation);
			var type = Text(destination["endpointType"]);
			var properties = destination["properties"]?.AsObject() ?? throw Invalid();
			// A masked endpoint cannot be replayed as if it were a real URL.
			if (type == "WebHook" && (Text(properties["endpointUrl"], 8192) is not { } url || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https" || url.Contains("***")))
				throw EventGridDeliveryRules.Bad("Azure withheld the existing webhook URL. Replace the destination with its full URL to edit headers or identity");
			if (edit?.Headers is { } headers)
			{
				if (type is not ("WebHook" or "EventHub") && headers.Count != 0)
					throw EventGridDeliveryRules.Bad("Custom delivery headers are supported here for WebHook and EventHub destinations");
				if (type is "NamespaceTopic" or "StorageQueue")
					properties.Remove("deliveryAttributeMappings");
				else
					properties["deliveryAttributeMappings"] = new JsonArray(headers.Select(h => (JsonNode?)h.Definition()).ToArray());
			}
			else if (properties["deliveryAttributeMappings"] is JsonArray oldHeaders && oldHeaders.Any(MaskedHeader))
				throw EventGridDeliveryRules.Bad("Azure withheld a secret header. Replace the headers explicitly to edit this delivery destination");
			var identity = edit?.Identity ?? (bound is null ? new EventGridIdentity("None", null) : IdentityDetails(bound["identity"]) ?? throw EventGridDeliveryRules.Bad("The existing identity is unsupported; choose an explicit identity"));
			if (edit?.WebhookAuthentication is { } auth)
			{
				if (type != "WebHook")
					throw EventGridDeliveryRules.Bad("Webhook token settings apply only to WebHook destinations");
				properties["azureActiveDirectoryTenantId"] = auth.TenantId;
				properties["azureActiveDirectoryApplicationIdOrUri"] = auth.ApplicationIdOrUri;
			}
			if (identity.Type != "None" && type == "WebHook" && (Text(properties["azureActiveDirectoryTenantId"], 1024) is not { } tenant || !Guid.TryParse(tenant, out _) || string.IsNullOrWhiteSpace(Text(properties["azureActiveDirectoryApplicationIdOrUri"], 1024))))
				throw EventGridDeliveryRules.Bad("Managed webhook delivery requires a tenant UUID and application ID/URI token audience");
			if (properties["deliveryAttributeMappings"] is JsonArray configuredHeaders && configuredHeaders.Any(h => string.Equals(Text(h?["name"], 64), "Authorization", StringComparison.OrdinalIgnoreCase)) && (type != "WebHook" || identity.Type != "None" || properties["azureActiveDirectoryApplicationIdOrUri"] is not null))
				throw EventGridDeliveryRules.Bad("An Authorization header is allowed only for a webhook without Entra authentication");
			if (identity.Type != "None" && type is not ("WebHook" or "EventHub" or "ServiceBusQueue" or "ServiceBusTopic" or "StorageQueue"))
				throw EventGridDeliveryRules.Bad("Managed delivery identity is supported for WebHook, Event Hubs, Service Bus and Storage Queue destinations");
			await RequireIdentity(identity, cancellation);
			if (identity.Type == "None")
			{
				part["destination"] = destination;
				part["deliveryWithResourceIdentity"] = null;
			}
			else
			{
				var wrapper = bound?.DeepClone().AsObject() ?? new JsonObject();
				wrapper["destination"] = destination;
				if (edit?.Identity is not null || bound is null)
					wrapper["identity"] = identity.Definition();
				part["destination"] = null;
				part["deliveryWithResourceIdentity"] = wrapper;
			}
		}
		if (edit?.DeadLetter is { } dead)
		{
			await RequireIdentity(dead.Identity, cancellation);
			part["deadLetterDestinationWithResourceIdentity"] = dead.Definition();
		}
	}
}
