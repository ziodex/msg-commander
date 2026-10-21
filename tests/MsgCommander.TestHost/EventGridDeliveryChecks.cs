using MsgCommander.Host;
using System.Text.Json;
using System.Text.Json.Nodes;
static class EventGridDeliveryChecks
{
	private static int count;
	private static void Assert(bool condition, string label)
	{
		if (!condition)
			throw new Exception(label);
		count++;
	}
	private static async Task Reject(Func<Task> action, EventGridWire wire)
	{
		var before = wire.Writes.Count;
		try
		{
			await action();
		}
		catch (OperationException) { Assert(wire.Writes.Count == before, "Rejected before dispatch"); return; }
		throw new Exception("Expected rejection");
	}
	private const string IdentityId = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/fixture-identity";
	private const string StorageId = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.Storage/storageAccounts/fixturestore";
	private const string HubId = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.EventHub/namespaces/fixture/eventhubs/orders";
	public static async Task<int> Run()
	{
		var wire = new EventGridWire();
		await using var gateway = await FixtureEventGridFactory.Connect(wire);
		var sub = new EventGridTarget("subscription", "orders", "audit");
		var queue = new EventGridTarget("subscription", "orders", "fulfillment");
		async Task<EventGridAdminChange> Change(EventGridTarget? target = null)
		{
			var t = target ?? sub;
			var read = await gateway.AdminGetAsync(t, default);
			return new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), t, "update", read.Revision, null, read.Settings, null, true, null);
		}
		JsonObject Part(EventGridTarget? t = null) => wire.Data[FixtureEventGridFactory.Root + (t ?? sub).Suffix()]["properties"]!["deliveryConfiguration"]![(t ?? sub) == queue ? "queue" : "push"]!.AsObject();
		async Task Apply(EventGridAdminChange c) => Assert(await gateway.ChangeAsync(c, () => { }, default) == "confirmed", "Change confirmed");
		var read = await gateway.AdminGetAsync(sub, default);
		Assert(!JsonSerializer.Serialize(read).Contains("SECRET"), "Editor projection omits URLs and all header values");
		Assert(read.Delivery!.DestinationType == "WebHook" && read.Delivery.Headers[0].Name == "Authorization", "Safe existing delivery labels");
		var original = Part().DeepClone();
		await Apply((await Change()) with
		{
			Settings = read.Settings! with
			{
				IncludedEventTypes = ["Order.Paid"]
			}
		});
		Assert(JsonNode.DeepEquals(original, Part()), "Unrelated edits preserve entire private delivery");
		Assert(JsonNode.Parse(wire.Writes[^1].Body!)!["properties"]!["deliveryConfiguration"] is null, "Unchanged delivery omitted from PATCH");
		var headers = new EventGridHeader[] { new("X-App", "Static", "SECRET-NEW", true), new("PartitionKey", "Dynamic", SourceField: "data.orderId") };
		await Apply((await Change()) with
		{
			Delivery = new(null, headers, null)
		});
		Assert(Part()["destination"]!["properties"]!["endpointUrl"]!.GetValue<string>().Contains("SECRET-URL"), "Header edit retains private webhook URL");
		Assert(Part()["destination"]!["properties"]!["deliveryAttributeMappings"]![0]!["properties"]!["isSecret"]!.GetValue<bool>(), "Static secret mapping serialized");
		Assert(Part()["destination"]!["properties"]!["deliveryAttributeMappings"]![1]!["properties"]!["sourceField"]!.GetValue<string>() == "data.orderId", "Dynamic mapping serialized");
		read = await gateway.AdminGetAsync(sub, default);
		Assert(!JsonSerializer.Serialize(read).Contains("SECRET"), "New private values excluded from editor");
		var system = new EventGridIdentity("SystemAssigned", null);
		var user = new EventGridIdentity("UserAssigned", IdentityId);
		var none = new EventGridIdentity("None", null);
		var hub = new EventGridDestination("EventHub", null, HubId, null);
		await Reject(async () => await gateway.ChangeAsync((await Change()) with { Destination = hub }, () => { }, default), wire);
		await Apply((await Change()) with
		{
			Destination = hub,
			Delivery = new(system, [], null)
		});
		Assert(Part()["destination"] is null && Part()["deliveryWithResourceIdentity"]!["identity"]!["type"]!.GetValue<string>() == "SystemAssigned", "System identity uses resource-identity wrapper and clears old destination");
		Assert(!Part().ToJsonString().Contains("SECRET"), "Destination replacement discards old URL and headers");
		await Apply((await Change()) with
		{
			Delivery = new(user, headers, new("set", StorageId, "deadletters", system))
		});
		Assert(Part()["deliveryWithResourceIdentity"]!["identity"]!["userAssignedIdentity"]!.GetValue<string>() == IdentityId, "User identity binding");
		Assert(Part()["deadLetterDestinationWithResourceIdentity"]!["deadLetterDestination"]!["properties"]!["resourceId"]!.GetValue<string>() == StorageId, "Dead-letter ARM shape uses storage account ID");
		Assert(Part()["deadLetterDestinationWithResourceIdentity"]!["deadLetterDestination"]!["properties"]!["blobContainerName"]!.GetValue<string>() == "deadletters", "Dead-letter blob container");
		var dead = Part()["deadLetterDestinationWithResourceIdentity"]!.DeepClone();
		await Apply((await Change()) with
		{
			Delivery = new(none, null, null)
		});
		Assert(Part()["deliveryWithResourceIdentity"] is null && Part()["destination"]!["endpointType"]!.GetValue<string>() == "EventHub", "Explicit default identity unwraps destination");
		Assert(JsonNode.DeepEquals(dead, Part()["deadLetterDestinationWithResourceIdentity"]), "Unchanged dead-letter preserved");
		await Apply((await Change()) with
		{
			Delivery = new(null, [], new("clear", null, null, null))
		});
		Assert(Part()["destination"]!["properties"]!["deliveryAttributeMappings"]!.AsArray().Count == 0 && Part()["deadLetterDestinationWithResourceIdentity"] is null, "Explicit clearing sends empty headers and null dead-letter wrapper");
		await Apply((await Change(queue)) with
		{
			Delivery = new(null, null, new("set", StorageId, "queue-deadletters", user))
		});
		Assert(Part(queue)["deadLetterDestinationWithResourceIdentity"]!["identity"]!["type"]!.GetValue<string>() == "UserAssigned", "Queue-mode dead-letter identity supported");
		var valid = await Change();
		foreach (var edit in new EventGridDelivery[] { new(new("UserAssigned", IdentityId + "-missing"), null, null), new(null, [new("aeg-test", "Static", "x", false)], null), new(null, [new("X-Test", "Static", new string('界', 1366), true)], null), new(null, [new("X-Test", "Static", "a\r\nb", true)], null), new(null, [new("X-Test", "Static", "a", true), new("x-test", "Static", "b", false)], null), new(null, Enumerable.Range(0, 11).Select(i => new EventGridHeader("X-" + i, "Static", "x", false)).ToArray(), null), new(null, null, new("set", StorageId + "/blobServices/default/containers/a", "abc", system)), new(null, null, new("set", StorageId, "bad--container", system)), new(null, null, new("set", StorageId, "abc", none)) })
			await Reject(() => gateway.ChangeAsync(valid with { Delivery = edit }, () => { }, default), wire);
		await Reject(async () => await gateway.ChangeAsync((await Change(queue)) with { Delivery = new(system, null, null) }, () => { }, default), wire);
		wire.Data[FixtureEventGridFactory.Root]["identity"] = null;
		await Reject(() => gateway.ChangeAsync(valid with { Delivery = new(system, null, null) }, () => { }, default), wire);
		wire.Data[FixtureEventGridFactory.Root]["identity"] = new JsonObject { ["type"] = "SystemAssigned" };
		await Apply((await Change()) with
		{
			Destination = new("WebHook", "https://new.invalid/?sig=SECRET-NEW-URL", null, null),
			Delivery = new(none, [], null)
		});
		await Apply((await Change()) with
		{
			Delivery = new(system, [], null, new("22222222-2222-2222-2222-222222222222", "api://fixture-webhook"))
		});
		Assert(Part()["deliveryWithResourceIdentity"]!["destination"]!["properties"]!["azureActiveDirectoryApplicationIdOrUri"]!.GetValue<string>() == "api://fixture-webhook", "Managed webhook audience and tenant serialized");
		await Reject(async () => await gateway.ChangeAsync((await Change()) with { Delivery = new(null, [new("Authorization", "Static", "SECRET-TOKEN", true)], null) }, () => { }, default), wire);
		await Apply((await Change()) with
		{
			Destination = new("WebHook", "https://new.invalid/?sig=SECRET-NEW-URL", null, null),
			Delivery = new(none, [new("Authorization", "Static", "SECRET-TOKEN", true)], null)
		});
		Assert(Part()["destination"]!["properties"]!["deliveryAttributeMappings"]!.AsArray().Count == 1, "Authorization accepted for non-Entra webhook");
		Part()["destination"]!["properties"]!.AsObject().Remove("endpointUrl");
		Part()["destination"]!["properties"]!["endpointBaseUrl"] = "https://new.invalid/";
		await Reject(async () => await gateway.ChangeAsync((await Change()) with { Delivery = new(null, headers, null) }, () => { }, default), wire);
		// Unrelated filters still work without replaying a provider-redacted endpoint.
		var redacted = await Change();
		await Apply(redacted with
		{
			Settings = redacted.Settings! with
			{
				IncludedEventTypes = ["Order.Redacted"]
			}
		});
		Assert(JsonNode.Parse(wire.Writes[^1].Body!)!["properties"]!["deliveryConfiguration"] is null, "Redacted URL not replayed for filter-only changes");
		Part()["destination"]!["properties"]!["endpointUrl"] = "https://new.invalid/?sig=SECRET";
		Part()["destination"]!["properties"]!["deliveryAttributeMappings"] = new JsonArray(new JsonObject { ["name"] = "X-Secret", ["type"] = "Static", ["properties"] = new JsonObject { ["isSecret"] = true } });
		await Reject(async () => await gateway.ChangeAsync((await Change()) with { Delivery = new(none, null, null) }, () => { }, default), wire);
		await Apply((await Change()) with
		{
			Delivery = new(null, headers, null)
		});
		var stale = await Change();
		Part()["futureDeliverySetting"] = "keep";
		await Reject(() => gateway.ChangeAsync(stale with { Delivery = new(null, [], null) }, () => { }, default), wire);
		await Apply((await Change()) with
		{
			Delivery = new(null, [], null)
		});
		Assert(Part()["futureDeliverySetting"]!.GetValue<string>() == "keep", "Future sibling properties preserved");
		await Apply((await Change()) with
		{
			Destination = new("NamespaceTopic", null, FixtureEventGridFactory.Root + "/topics/archive", null),
			Delivery = new(none, [], null)
		});
		Assert(Part()["destination"]!["properties"]!["deliveryAttributeMappings"] is null, "Replacement destinations without header support omit unsupported mapping fields");
		await Apply((await Change()) with
		{
			Destination = new("WebHook", "https://private.invalid/?sig=SECRET-FULL", null, null),
			Delivery = new(system, [], null, new("22222222-2222-2222-2222-222222222222", "api://private"))
		});
		var wrapper = Part()["deliveryWithResourceIdentity"]!;
		wrapper["futureWrapper"] = "keep-wrapper";
		wrapper["identity"]!["futureIdentity"] = "keep-identity";
		await Apply((await Change()) with
		{
			Delivery = new(null, headers, null)
		});
		Assert(Part()["deliveryWithResourceIdentity"]!["futureWrapper"]!.GetValue<string>() == "keep-wrapper" && Part()["deliveryWithResourceIdentity"]!["identity"]!["futureIdentity"]!.GetValue<string>() == "keep-identity", "Header-only edit preserves future identity/wrapper fields");
		JsonObject Private() => Part()["deliveryWithResourceIdentity"]!["destination"]!["properties"]!.AsObject();
		Private().Remove("endpointUrl");
		Private()["endpointBaseUrl"] = "https://private.invalid/";
		wire.PrivateFullUrl = "https://private.invalid/?sig=SECRET-FULL";
		await Apply((await Change()) with
		{
			Delivery = new(null, null, new("set", StorageId, "deadletters", system))
		});
		Assert(Private()["endpointUrl"]!.GetValue<string>() == wire.PrivateFullUrl, "Dead-letter-only PATCH hydrates the actual outgoing private URL");
		Private()["deliveryAttributeMappings"] = new JsonArray(new JsonObject { ["name"] = "X-Private", ["type"] = "Static", ["properties"] = new JsonObject { ["isSecret"] = true, ["value"] = "*****", ["futureHeader"] = "keep-header" } });
		wire.PrivateAttributes = new JsonArray(new JsonObject { ["name"] = "X-Private", ["type"] = "Static", ["properties"] = new JsonObject { ["isSecret"] = true, ["value"] = "SECRET-RESTORED" } });
		await Apply((await Change()) with
		{
			Delivery = new(null, null, new("clear", null, null, null))
		});
		Assert(Private()["deliveryAttributeMappings"]![0]!["properties"]!["value"]!.GetValue<string>() == "SECRET-RESTORED" && Private()["deliveryAttributeMappings"]![0]!["properties"]!["futureHeader"]!.GetValue<string>() == "keep-header", "Private attribute read restores only values and preserves future fields");
		Assert(!JsonSerializer.Serialize(await gateway.AdminGetAsync(sub, default)).Contains("SECRET"), "Hydrated private reads never leak to editor");
		Private().Remove("endpointUrl");
		var beforePrivate = await Change();
		wire.BeforeDeliveryRead = _ => { Part()["concurrentSetting"] = "changed"; return Task.CompletedTask; };
		await Reject(() => gateway.ChangeAsync(beforePrivate with { Delivery = new(null, [], null) }, () => { }, default), wire);
		wire.BeforeDeliveryRead = null;
		var cancelled = await Change();
		var beforeCancel = wire.Writes.Count;
		wire.BeforeDeliveryRead = token => Task.Delay(10000, token);
		using (var cancel = new CancellationTokenSource(50))
		{
			try
			{
				await gateway.ChangeAsync(cancelled with
				{
					Delivery = new(null, [], null)
				}, () => throw new Exception("Dispatched cancelled private read"), cancel.Token);
				throw new Exception("Missing cancellation");
			}
			catch (OperationCanceledException) { Assert(wire.Writes.Count == beforeCancel, "Private-read cancellation sends no mutation"); }
		}
		wire.BeforeDeliveryRead = null;
		wire.PrivateFullUrl = "https://private.invalid/?sig=***";
		await Reject(async () => await gateway.ChangeAsync((await Change()) with { Delivery = new(null, [], null) }, () => { }, default), wire);
		wire.PrivateFullUrl = "https://private.invalid/?sig=SECRET-FULL";
		Private()["deliveryAttributeMappings"]![0]!["properties"]!["value"] = "*****";
		wire.PrivateAttributes = new JsonArray(Enumerable.Range(0, 11).Select(i => (JsonNode?)new JsonObject { ["name"] = "X-" + i }).ToArray());
		await Reject(async () => await gateway.ChangeAsync((await Change()) with { Delivery = new(null, null, new("set", StorageId, "deadletters", system)) }, () => { }, default), wire);
		Assert(wire.Requests.All(r => r.Host == "management.azure.com" && r.AbsolutePath.StartsWith(FixtureEventGridFactory.Root)), "All configuration calls remain scoped ARM calls");
		Console.WriteLine($"Event Grid delivery adapter checks passed ({count} assertions)");
		return 0;
	}
}
