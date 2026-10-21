using MsgCommander.Application.EventGrid.Administration;
using MsgCommander.Host;
using System.Net;
using System.Text.Json.Nodes;
using System.Text.Json;
static class EventGridAdministrationChecks
{
	private static int count;
	private static void Assert(bool condition, string label)
	{
		if (!condition)
			throw new Exception(label);
		count++;
	}
	private static async Task Reject(Func<Task> work)
	{
		try
		{
			await work();
		}
		catch (OperationException) { count++; return; }
		throw new Exception("Expected validation rejection");
	}
	private static EventGridAdminChange Change(EventGridTarget target, string action = "create", string? revision = null, int? days = 7, EventGridSubscriptionSettings? settings = null, EventGridDestination? destination = null) => new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, action, revision, days, settings, destination, true, action == "delete" ? target.SubscriptionName ?? target.TopicName : null);
	private sealed class ReadyFactory(IEventGridGateway gateway) : IEventGridGatewayFactory
	{
		public Task<IEventGridGateway> ConnectAsync(ConnectionProfile profile, EventGridManagement management, Func<DeviceCodeEvent, Task> code, CancellationToken cancellation) => Task.FromResult(gateway);
	}
	public static async Task<int> Run()
	{
		var wire = new EventGridWire();
		await using var gateway = await FixtureEventGridFactory.Connect(wire);
		var topic = new EventGridTarget("topic", "new-topic", null);
		var source = new EventGridTarget("topic", "orders", null);
		var sub = new EventGridTarget("subscription", "orders", "fulfillment");
		var settings = (await gateway.AdminGetAsync(sub, default)).Settings!;
		Assert(EventGridCommands.Prepare(Change(topic)) is CreateEventGridTopic { RetentionDays: 7 }, "Create topic has required retention");
		Assert(EventGridCommands.Prepare(Change(topic, "update", new string('A', 64))) is UpdateEventGridTopic { Revision.Length: 64 }, "Update topic requires a reviewed revision");
		Assert(EventGridCommands.Prepare(Change(topic, "delete", new string('A', 64), null)) is DeleteEventGridResource, "Deletion carries no settings");
		Assert(EventGridCommands.Prepare(Change(sub, days: null, settings: settings)) is CreateEventGridSubscription { Settings: not null }, "Create subscription has required settings");
		Assert(EventGridCommands.Prepare(Change(sub, "update", new string('A', 64), null, settings)) is UpdateEventGridSubscription { Settings: not null }, "Update subscription has required settings");
		var dispatches = 0;
		Assert(await gateway.ChangeAsync(Change(topic), () => dispatches++, default) == "confirmed", "Create confirmed");
		var create = JsonNode.Parse(wire.Writes[^1].Body!)!;
		Assert(create["properties"]!["inputSchema"]!.GetValue<string>() == "CloudEventSchemaV1_0", "CloudEvents schema only");
		await Reject(() => gateway.ChangeAsync(Change(topic), () => dispatches++, default));
		Assert(dispatches == 1, "Create refuses existing resource without writing");
		var read = await gateway.AdminGetAsync(topic, default);
		wire.Data[FixtureEventGridFactory.Root + topic.Suffix()]["properties"]!["futureProperty"] = "keep";
		await Reject(() => gateway.ChangeAsync(Change(topic, "update", read.Revision, 3), () => dispatches++, default));
		Assert(dispatches == 1, "Fresh-read concurrency guard");
		read = await gateway.AdminGetAsync(topic, default);
		await gateway.ChangeAsync(Change(topic, "update", read.Revision, 3), () => dispatches++, default);
		Assert(wire.Writes[^1].Method == "PATCH" && JsonNode.Parse(wire.Writes[^1].Body!)!["properties"]!.AsObject().Count == 1, "Topic PATCH changes only retention");
		Assert(wire.Data[FixtureEventGridFactory.Root + topic.Suffix()]["properties"]!["futureProperty"]!.GetValue<string>() == "keep", "Unknown topic settings preserved");
		var current = await gateway.AdminGetAsync(sub, default);
		Assert(current.Settings!.Filters![0].OperandJson.Contains("9007199254740993"), "Precise filter operand returned as text");
		var p = wire.Data[FixtureEventGridFactory.Root + sub.Suffix()]["properties"]!;
		p["deliveryConfiguration"]!["queue"]!["deadLetterDestinationWithResourceIdentity"] = new JsonObject { ["secret"] = "SECRET-DEADLETTER" };
		p["filtersConfiguration"]!["futureSetting"] = true;
		current = await gateway.AdminGetAsync(sub, default);
		await gateway.ChangeAsync(Change(sub, "update", current.Revision, null, current.Settings! with
		{
			MaxDeliveryCount = 9
		}), () => dispatches++, default);
		var body = wire.Writes[^1].Body!;
		Assert(body.Contains("9007199254740993") && body.Contains("SECRET-DEADLETTER") && body.Contains("futureSetting"), "Subscription PATCH preserves precise operands and private nested settings");
		var audit = sub with
		{
			SubscriptionName = "audit"
		};
		current = await gateway.AdminGetAsync(audit, default);
		Assert(current.Settings!.Filters is null && !JsonSerializer.Serialize(current).Contains("SECRET"), "Unsupported filters not exposed or editable");
		await gateway.ChangeAsync(Change(audit, "update", current.Revision, null, current.Settings! with
		{
			IncludedEventTypes = ["Order.Paid"],
			EventTimeToLive = "P2D"
		}), () => dispatches++, default);
		body = wire.Writes[^1].Body!;
		Assert(body.Contains("SECRET-URL") && body.Contains("SECRET-HEADER") && body.Contains("SECRET-FILTER"), "Existing Push endpoint/auth/unknown filters preserved privately");
		Assert(!JsonSerializer.Serialize(await gateway.AdminGetAsync(audit, default)).Contains("SECRET"), "No secrets returned after edit");
		var before = wire.Writes.Count;
		var parent = wire.Data[FixtureEventGridFactory.Root + source.Suffix()]["properties"]!;
		parent["eventRetentionInDays"] = 1;
		var newSub = sub with
		{
			SubscriptionName = "ttl-check"
		};
		await Reject(() => gateway.ChangeAsync(Change(newSub, days: null, settings: settings with { EventTimeToLive = "P2D" }), () => dispatches++, default));
		Assert(wire.Writes.Count == before, "TTL checked against current parent retention before write");
		parent["eventRetentionInDays"] = 7;
		foreach (var op in new[] { "BoolEquals", "IsNotNull", "IsNullOrUndefined", "NumberGreaterThan", "NumberGreaterThanOrEquals", "NumberIn", "NumberInRange", "NumberLessThan", "NumberLessThanOrEquals", "NumberNotIn", "NumberNotInRange", "StringBeginsWith", "StringContains", "StringEndsWith", "StringIn", "StringNotBeginsWith", "StringNotContains", "StringNotEndsWith", "StringNotIn" })
		{
			var operand = op == "BoolEquals" ? "true" : op.StartsWith("Is") ? "" : op.EndsWith("Range") ? "[[9007199254740993,9007199254740995]]" : op.Contains("GreaterThan") || op.Contains("LessThan") ? "9007199254740993" : op.StartsWith("Number") ? "[9007199254740993]" : "[\"orders/\"]";
			await gateway.ChangeAsync(Change(newSub with
			{
				SubscriptionName = "op-" + op
			}, days: null, settings: settings with
			{
				Filters = [new("data.value", op, operand)]
			}), () => dispatches++, default);
			count++;
		}
		foreach (var f in new[] { new EventGridAdminFilter("data.x", "BoolEquals", "1"), new("data.x", "NumberIn", "[\"1\"]"), new("data.x", "NumberInRange", "[[2,1]]"), new("data.x", "NumberInRange", "[1,2]"), new("data.x", "StringIn", "[1]"), new("data.x", "IsNotNull", "null"), new("data.x", "NumberGreaterThan", "1e999"), new("data.x", "FutureOperator", "[]"), new("", "StringIn", "[\"a\"]"), new("data.x", "StringIn", "[\"a\"] trailing") })
			await Reject(() => gateway.ChangeAsync(Change(newSub, days: null, settings: settings with { Filters = [f] }), () => dispatches++, default));
		await Reject(() => gateway.ChangeAsync(Change(newSub, days: null, settings: settings with { Filters = [new("data.x", "NumberIn", "[0,1,2,3,4,5,6,7,8,9,10,11,12]"), new("data.y", "NumberIn", "[0,1,2,3,4,5,6,7,8,9,10,11,12]")] }), () => dispatches++, default));
		await Reject(() => gateway.ChangeAsync(Change(newSub, days: null, settings: settings with { Filters = [new("data.x", "StringIn", "[\"" + new string('x', 513) + "\"]")] }), () => dispatches++, default));
		foreach (var invalid in new[] { settings with { MaxDeliveryCount = 11 }, settings with { ReceiveLockDurationInSeconds = 59 }, settings with { EventTimeToLive = "PT30S" }, settings with { ExpirationTimeUtc = "2020-01-01T00:00:00Z" } })
			await Reject(() => gateway.ChangeAsync(Change(newSub, days: null, settings: invalid), () => dispatches++, default));
		foreach (var destination in new[] { new EventGridDestination("WebHook", "http://example.invalid", null, null), new("WebHook", "https://user:password@example.invalid", null, null), new("ServiceBusQueue", null, FixtureEventGridFactory.Root, null), new("StorageQueue", null, "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.Storage/storageAccounts/test", "bad--name") })
			await Reject(() => gateway.ChangeAsync(Change(newSub, days: null, settings: settings with { DeliveryMode = "Push", ReceiveLockDurationInSeconds = null }, destination: destination), () => dispatches++, default));
		await gateway.ChangeAsync(Change(newSub, days: null, settings: settings with
		{
			DeliveryMode = "Push",
			ReceiveLockDurationInSeconds = null
		}, destination: new("WebHook", "https://example.invalid/?sig=SECRET-CREATE", null, null)), () => dispatches++, default);
		Assert(!JsonSerializer.Serialize(await gateway.AdminGetAsync(newSub, default)).Contains("SECRET-CREATE"), "New WebHook URL write-only");
		current = await gateway.AdminGetAsync(newSub, default);
		await Reject(() => gateway.ChangeAsync(Change(newSub, "update", current.Revision, null, settings), () => dispatches++, default));
		wire.WriteOverride = (_, _) => Task.FromResult<HttpResponseMessage?>(new(HttpStatusCode.Accepted) { Headers = { { "Location", "https://evil.invalid/?SECRET" } } });
		current = await gateway.AdminGetAsync(topic, default);
		var requests = wire.Requests.Count;
		Assert(await gateway.ChangeAsync(Change(topic, "update", current.Revision, 2), () => dispatches++, default) == "accepted", "202 accepted is not completion");
		Assert(wire.Requests.Count == requests + 2, "Provider poll URL never followed");
		wire.WriteOverride = (_, _) => Task.FromResult<HttpResponseMessage?>(new(HttpStatusCode.Created) { Content = new StringContent("malformed SECRET") });
		Assert(await gateway.ChangeAsync(Change(newSub with
		{
			SubscriptionName = "acknowledged"
		}, days: null, settings: settings), () => dispatches++, default) == "accepted", "Acknowledgment survives malformed body");
		wire.WriteOverride = null;
		wire.WriteOverride = (_, _) => Task.FromResult<HttpResponseMessage?>(new(HttpStatusCode.OK) { Content = new StringContent(new JsonObject { ["id"] = FixtureEventGridFactory.Root + topic.Suffix(), ["properties"] = new JsonObject { ["provisioningState"] = "Failed" } }.ToJsonString()) });
		current = await gateway.AdminGetAsync(topic, default);
		Assert(await gateway.ChangeAsync(Change(topic, "update", current.Revision, 2), () => dispatches++, default) == "failed", "Terminal failed provisioning is distinct from accepted");
		wire.WriteOverride = null;
		current = await gateway.AdminGetAsync(topic, default);
		await Reject(() => gateway.ChangeAsync(Change(topic, "delete", current.Revision, null) with { Confirmation = "wrong" }, () => dispatches++, default));
		await gateway.ChangeAsync(Change(topic, "delete", current.Revision, null), () => dispatches++, default);
		Assert(!wire.Data.ContainsKey(FixtureEventGridFactory.Root + topic.Suffix()), "Topic deleted");
		Assert(wire.Requests.All(r => r.Host == "management.azure.com" && r.Query.Contains("api-version=2025-02-15")), "All reads/writes stay in stable selected ARM scope");
		var large = wire.Data[FixtureEventGridFactory.Root + sub.Suffix()]["properties"]!;
		large["filtersConfiguration"] = new JsonObject { ["includedEventTypes"] = new JsonArray(Enumerable.Range(0, 100).Select(i => (JsonNode?)JsonValue.Create(new string('界', 1024))).ToArray()), ["filters"] = new JsonArray(Enumerable.Range(0, 25).Select(i => (JsonNode?)new JsonObject { ["key"] = "data.number" + i, ["operatorType"] = "NumberGreaterThan", ["value"] = JsonNode.Parse("0." + new string('0', 30000) + "1") }).ToArray()) };
		await using (var workspace = new EventGridWorkspace(new ReadyFactory(gateway)))
		{
			var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
			var connection = (EventGridConnection)(await workspace.ExecuteAsync("eg.connect", JsonSerializer.SerializeToElement(new
			{
				operationId = Guid.NewGuid().ToString(),
				profile = new
				{
					id = Guid.NewGuid().ToString(),
					name = "Fixture",
					service = "event-grid",
					@namespace = FixtureEventGridFactory.Host,
					auth = "device-code",
					tenantId = "fixture",
					clientId = Guid.NewGuid().ToString(),
					rememberSecret = false
				},
				management = new EventGridManagement(FixtureEventGridFactory.Root, "fixture", Guid.NewGuid().ToString())
			}, options), _ => Task.CompletedTask, default))!;
			try
			{
				await workspace.ExecuteAsync("eg.admin.get", JsonSerializer.SerializeToElement(new
				{
					id = Guid.NewGuid().ToString(),
					connectionId = connection.ConnectionId,
					target = sub
				}, options), _ => Task.CompletedTask, default);
				throw new Exception("Editor frame limit was not enforced");
			}
			catch (OperationException e) { Assert(e.Message.Contains("editor metadata exceeds"), "Oversized editable projection rejected before framing"); }
		}
		Console.WriteLine($"Event Grid administration adapter checks passed ({count} assertions)");
		return 0;
	}
}
