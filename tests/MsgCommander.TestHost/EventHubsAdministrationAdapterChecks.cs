using System.Text.Json;
using System.Text.Json.Nodes;
using MsgCommander.Host;

static class EventHubsAdministrationAdapterChecks
{
	static void Assert(bool value, string label)
	{
		if (!value)
			throw new Exception(label);
	}
	public static async Task<int> Run()
	{
		var profile = new ConnectionProfile(Guid.NewGuid().ToString(), "Fixture", "event-hubs", "fixture.servicebus.windows.net", "sas", "", "", "offline");
		await using var gateway = new FixtureEventHubsGateway(profile, new(FixtureEventHubsGateway.ResourceId, "fixture", Guid.NewGuid().ToString()));
		var admin = gateway.Administration!;
		var target = new EventAdminTarget("hub", "telemetry");
		var root = FixtureEventHubsGateway.ResourceId;
		var path = root + "/eventhubs/telemetry";
		var properties = gateway.Wire.Data(path)["properties"]!.AsObject();
		properties["captureDescription"] = new JsonObject { ["enabled"] = true, ["encoding"] = "Avro", ["intervalInSeconds"] = 120, ["sizeLimitInBytes"] = 10485760, ["skipEmptyArchives"] = true, ["destination"] = new JsonObject { ["name"] = "EventHubArchive.AzureBlockBlob", ["properties"] = new JsonObject { ["storageAccountResourceId"] = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.Storage/storageAccounts/fixturestore", ["blobContainer"] = "archive", ["archiveNameFormat"] = "{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}" } } };
		properties["messageTimestampDescription"] = new JsonObject { ["timestampType"] = "LogAppend" };
		var before = await admin.GetAsync(target, default);
		Assert(before.Hub is not null, "Editable hub projection");
		var settings = before.Hub! with
		{
			RetentionHours = 48,
			UserMetadata = "Edited"
		};
		var called = false;
		await admin.ChangeAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, "update", before.Revision, settings, null, null, null, true, ""), () => called = true, default);
		Assert(called, "Mutation dispatch was reported");
		var put = gateway.Wire.Requests.Single(r => r.Method == "PUT");
		var sent = JsonNode.Parse(put.Body!)!["properties"]!;
		Assert(sent["captureDescription"]!["destination"]!["properties"]!["blobContainer"]!.GetValue<string>() == "archive", "Existing Capture preserved");
		Assert(sent["messageTimestampDescription"]!["timestampType"]!.GetValue<string>() == "LogAppend", "Unedited timestamp policy preserved");
		Assert(sent["retentionDescription"]!["retentionTimeInHours"]!.GetValue<int>() == 48, "Hourly retention serialized");
		Assert(sent["futureSetting"]?.GetValue<string>() == "preserved", "Unmodeled Azure settings preserved");
		var next = await admin.GetAsync(target, default);
		Assert(next.Revision != before.Revision, "Revision covers mutable settings");
		var capture = JsonSerializer.SerializeToElement(new
		{
			mode = "configure",
			intervalSeconds = 180,
			sizeBytes = 20971520,
			skipEmpty = false,
			storageAccountResourceId = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.Storage/storageAccounts/newstore",
			blobContainer = "newarchive",
			archiveNameFormat = "{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}",
			identity = "UserAssigned",
			userAssignedIdentity = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/capture"
		});
		await admin.ChangeAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, "update", next.Revision, next.Hub! with
		{
			Capture = capture
		}, null, null, null, true, ""), () => { }, default);
		var configured = gateway.Wire.Data(path)["properties"]!["captureDescription"]!;
		Assert(configured["destination"]!["properties"]!["blobContainer"]!.GetValue<string>() == "newarchive", "Explicit Capture replacement reaches wire");
		Assert(configured["destination"]!["identity"]!["type"]!.GetValue<string>() == "UserAssigned", "Capture managed identity reaches wire");
		Assert(configured["intervalInSeconds"]!.GetValue<int>() == 180 && configured["encoding"]!.GetValue<string>() == "Avro", "Capture intervals and encoding serialized");
		next = await admin.GetAsync(target, default);
		await admin.ChangeAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, "update", next.Revision, next.Hub! with
		{
			Capture = JsonSerializer.SerializeToElement(new
			{
				mode = "disabled"
			})
		}, null, null, null, true, ""), () => { }, default);
		var disabled = gateway.Wire.Data(path)["properties"]!["captureDescription"]!;
		Assert(!disabled["enabled"]!.GetValue<bool>() && disabled["destination"]!["properties"]!["blobContainer"]!.GetValue<string>() == "newarchive", "Disable retains destination configuration");
		var groupTarget = new EventAdminTarget("group", "dashboard", "telemetry");
		var groupPath = path + "/consumergroups/dashboard";
		gateway.Wire.Data(groupPath)["properties"]!["futureGroupSetting"] = new JsonObject { ["nested"] = true };
		var group = await admin.GetAsync(groupTarget, default);
		await admin.ChangeAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), groupTarget, "update", group.Revision, null, "Updated group metadata", null, null, true, ""), () => { }, default);
		Assert(gateway.Wire.Data(groupPath)["properties"]!["futureGroupSetting"]!["nested"]!.GetValue<bool>(), "Group metadata update preserves unmodeled settings");
		Assert(gateway.Wire.Paths.Where(p => !p.Contains("fixturePage")).All(p => p.Contains("api-version=2026-01-01")), "Administration uses the SDK's pinned 2026-01-01 API version");
		Assert(gateway.Wire.Paths.All(p => p.StartsWith(root)), "All SDK requests scoped to selected namespace");
		Console.WriteLine("Event Hubs administration adapter checks passed");
		return 0;
	}
}
