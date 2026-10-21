using System.Text.Json;
using System.Text.Json.Nodes;
using MsgCommander.Host;
static class EventGridAdapterChecks
{
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	static async Task Reject(Func<Task> action)
	{
		try
		{
			await action();
			throw new Exception("Unsafe metadata accepted");
		}
		catch (OperationException) { }
	}
	public static async Task<int> Run()
	{
		var wire = new EventGridWire();
		await using var gateway = await FixtureEventGridFactory.Connect(wire);
		var ns = new EventGridTarget("namespace", null, null);
		var topic = new EventGridTarget("topic", "orders", null);
		var sub = new EventGridTarget("subscription", "orders", "fulfillment");
		Assert(wire.Requests.Single().AbsolutePath == FixtureEventGridFactory.Root, "Connect reads only selected namespace");
		var page = await gateway.ListAsync(ns, null, default);
		Assert(page.Items.Count == 2 && page.ContinuationToken is not null, "Topics page");
		Assert((await gateway.ListAsync(ns, page.ContinuationToken, default)).Items.Count == 4, "Next page");
		Assert((await gateway.ListAsync(topic, null, default)).Items[0].DeliveryMode == "Queue", "Subscriptions include delivery mode");
		var details = await gateway.GetAsync(sub, default);
		Assert(details.Filters!.Filters.Count == 4, "Advanced filter projection");
		Assert(details.Filters.Filters[0].DefinitionJson.Contains("9007199254740993"), "Filter numbers retain JSON precision");
		Assert(details.Filters.Filters[1].DefinitionJson.Contains("true"), "Boolean typed value retained");
		Assert(details.Filters.IncludedEventTypes!.Count == 2 && details.DeliveryJson!.Contains("receiveLockDurationInSeconds"), "Event types and Queue delivery settings");
		var audit = await gateway.GetAsync(sub with
		{
			SubscriptionName = "audit"
		}, default);
		Assert(audit.Filters!.IncludedEventTypes is null && !audit.Filters.Filters[0].Known && audit.Warning!.Contains("unknown filter"), "Unknown operators and default event types visible");
		Assert(!JsonSerializer.Serialize(audit).Contains("SECRET"), "Push URLs, delivery headers and unsupported filter fields omitted");
		var empty = await gateway.GetAsync(sub with
		{
			SubscriptionName = "extra"
		}, default);
		Assert(empty.Filters!.IncludedEventTypes!.Count == 0, "Empty event types distinct from absent");
		foreach (var next in new[] { "https://evil.invalid" + FixtureEventGridFactory.Root + "/topics?api-version=2025-02-15", "https://management.azure.com" + FixtureEventGridFactory.Root + "/topics/orders/eventSubscriptions?api-version=2025-02-15", "https://user@management.azure.com" + FixtureEventGridFactory.Root + "/topics?api-version=2025-02-15", "https://management.azure.com" + FixtureEventGridFactory.Root + "/topics?api-version=2023-12-15-preview", "https://management.azure.com" + FixtureEventGridFactory.Root + "/topics?api-version=2025-02-15&api-version=2025-02-15" })
		{
			var count = wire.Requests.Count;
			await Reject(() => gateway.ListAsync(ns, next, default));
			Assert(wire.Requests.Count == count, "Bad cursor rejected before credentials sent");
		}
		wire.NextLinkOverride = "https://evil.invalid/?SECRET";
		await Reject(() => gateway.ListAsync(ns, null, default));
		wire.NextLinkOverride = null;
		var raw = wire.Data[FixtureEventGridFactory.Root + sub.Suffix()];
		var config = raw["properties"]!["filtersConfiguration"]!;
		var operators = new[] { "BoolEquals", "IsNotNull", "IsNullOrUndefined", "NumberGreaterThan", "NumberGreaterThanOrEquals", "NumberIn", "NumberInRange", "NumberLessThan", "NumberLessThanOrEquals", "NumberNotIn", "NumberNotInRange", "StringBeginsWith", "StringContains", "StringEndsWith", "StringIn", "StringNotBeginsWith", "StringNotContains", "StringNotEndsWith", "StringNotIn" };
		config["filters"] = new JsonArray(operators.Select(op => (JsonNode?)new JsonObject { ["key"] = "data.test", ["operatorType"] = op }).ToArray());
		Assert((await gateway.GetAsync(sub, default)).Filters!.Filters.All(f => f.Known), "All 19 stable operator discriminators supported");
		raw["name"] = "wrong";
		await Reject(() => gateway.GetAsync(sub, default));
		raw["name"] = "fulfillment";
		raw["id"] = FixtureEventGridFactory.Root + "/topics/other/eventSubscriptions/fulfillment";
		await Reject(() => gateway.GetAsync(sub, default));
		raw["id"] = FixtureEventGridFactory.Root + sub.Suffix();
		wire.ReplyOverride = "{\"value\":[],\"value\":[]}";
		await Reject(() => gateway.ListAsync(ns, null, default));
		wire.ReplyOverride = "{\"value\":[],\"extra\":\"" + new string('x', 2 * 1024 * 1024) + "\"}";
		await Reject(() => gateway.ListAsync(ns, null, default));
		wire.ReplyOverride = null;
		config["filters"] = new JsonArray(new JsonObject { ["key"] = "data.test", ["operatorType"] = "StringIn", ["values"] = new JsonArray(new string('x', 65536)) });
		await Reject(() => gateway.GetAsync(sub, default));
		var countBefore = wire.Requests.Count;
		foreach (var name in new[] { "../escape", "a/b", "a?token=x", "..", "xx" })
			await Reject(() => gateway.GetAsync(topic with { TopicName = name }, default));
		Assert(countBefore == wire.Requests.Count, "Unsafe entity names rejected before sending");
		wire.Data[FixtureEventGridFactory.Root]["properties"]!["topicsConfiguration"]!["hostname"] = "fixture.mqtt.eventgrid.azure.net";
		await Reject(() => FixtureEventGridFactory.Connect(wire));
		Assert(wire.Requests.All(r => r.Query.Contains("api-version=2025-02-15")), "Stable documented ARM version only");
		Console.WriteLine("Event Grid adapter checks passed");
		return 0;
	}
}
