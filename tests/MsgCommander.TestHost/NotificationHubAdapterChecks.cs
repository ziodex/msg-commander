using System.Text.Json;
using System.Text.Json.Nodes;
using MsgCommander.Host;
static class NotificationHubAdapterChecks
{
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	public static async Task<int> Run()
	{
		var wire = new NotificationHubWire();
		await using var gateway = await FixtureNotificationHubFactory.Connect(wire);
		var target = new NotificationHubTarget(new("hub", "alerts"), null);
		var current = await gateway.GetAsync(target, default);
		Assert(!JsonSerializer.Serialize(current).Contains("SECRET"), "Provider and embedded policy keys never projected");
		wire.Data(target.Suffix())["properties"]!["registrationCount"] = 3;
		wire.Data(target.Suffix())["properties"]!["updatedAt"] = "2026-10-11T12:00:00Z";
		Assert((await gateway.GetAsync(target, default)).Revision == current.Revision, "Runtime changes do not invalidate revision");
		var change = new NotificationHubChange(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, "update", current.Revision, new("90.00:00:00", [new("project", "Commander")]), null, null, true);
		var dispatched = false;
		await gateway.ChangeAsync(change, () => dispatched = true, default);
		Assert(dispatched, "Reports write dispatch");
		var patch = JsonNode.Parse(wire.Requests.Single(r => r.Method == "PATCH").Body!)!;
		Assert(patch["properties"]!.AsObject().Count == 1 && patch["location"] is null, "PATCH sends only lifetime and tags");
		var data = wire.Data(target.Suffix());
		Assert(data["properties"]!["futureSetting"]!.GetValue<string>() == "preserved", "Unknown settings retained");
		Assert(data["properties"]!["gcmCredential"]!["properties"]!["googleApiKey"]!.GetValue<string>() == "SECRET-PNS", "Provider credentials retained");
		Assert(data["properties"]!["authorizationRules"]![0]!["primaryKey"]!.GetValue<string>() == "SECRET-EMBEDDED-KEY", "Embedded rules retained");
		Assert((await gateway.GetAsync(target, default)).Settings!.Tags.Single().Value == "Commander", "Tags round trip");
		try
		{
			await gateway.ChangeAsync(change, () => throw new Exception("Stale write dispatched"), default);
			throw new Exception("Stale revision accepted");
		}
		catch (OperationException) { }
		Assert(wire.Requests.All(r => r.Path.Contains("api-version=2023-09-01")), "Pinned documented ARM version");
		var scope = new NotificationHubScope("namespace", "");
		var page = await gateway.ListAsync(scope, "hubs", null, default);
		Assert(page.Items.Count == 2 && page.ContinuationToken is not null, "Paging");
		Assert((await gateway.ListAsync(scope, "hubs", page.ContinuationToken, default)).Items.Single().Target.Scope.Name == "more-alerts", "Next page");
		foreach (var next in new[] { "https://evil.invalid" + FixtureNotificationHubFactory.Root + "/notificationHubs", "https://management.azure.com" + FixtureNotificationHubFactory.Root + "/authorizationRules", "https://user@management.azure.com" + FixtureNotificationHubFactory.Root + "/notificationHubs" })
		{
			var count = wire.Requests.Count;
			try
			{
				await gateway.ListAsync(scope, "hubs", next, default);
				throw new Exception("Unscoped continuation accepted");
			}
			catch (OperationException) { }
			Assert(count == wire.Requests.Count, "Rejected before sending credentials");
		}
		foreach (var name in new[] { ".", "..", "a/b", "a?b" })
		{
			var count = wire.Requests.Count;
			try
			{
				await gateway.KeyAsync(new(scope, name), "PrimaryKey", default);
				throw new Exception("Invalid policy accepted");
			}
			catch (OperationException) { }
			Assert(count == wire.Requests.Count, "Invalid names rejected before sending");
		}
		var policy = new NotificationHubTarget(target.Scope, "alerts-reader");
		var primary = await gateway.KeyAsync(policy, "PrimaryKey", default);
		var secondary = await gateway.KeyAsync(policy, "SecondaryKey", default);
		var policyDetails = await gateway.GetAsync(policy, default);
		var rights = change with
		{
			Target = policy,
			ExpectedRevision = policyDetails.Revision,
			Settings = null,
			Rights = ["Listen", "Send"]
		};
		await gateway.ChangeAsync(rights, () => { }, default);
		Assert(await gateway.KeyAsync(policy, "PrimaryKey", default) == primary, "Rights edits preserve primary");
		policyDetails = await gateway.GetAsync(policy, default);
		await gateway.ChangeAsync(rights with
		{
			Action = "regenerate",
			ExpectedRevision = policyDetails.Revision,
			Rights = null,
			KeyType = "SecondaryKey"
		}, () => { }, default);
		var body = JsonNode.Parse(wire.Requests.Single(r => r.Path.Contains("/regenerateKeys")).Body!)!.AsObject();
		Assert(body.Count == 1 && body["policyKey"]!.GetValue<string>() == "SecondaryKey", "Documented policyKey regeneration contract");
		Assert(await gateway.KeyAsync(policy, "PrimaryKey", default) == primary && await gateway.KeyAsync(policy, "SecondaryKey", default) != secondary, "Only selected slot changes");
		var root = new NotificationHubTarget(scope, "RootManageSharedAccessKey");
		var rootDetails = await gateway.GetAsync(root, default);
		foreach (var action in new[] { "delete", "update" })
		{
			try
			{
				await gateway.ChangeAsync(rights with
				{
					Target = root,
					Action = action,
					ExpectedRevision = rootDetails.Revision,
					Rights = action == "update" ? ["Send"] : null
				}, () => throw new Exception("Root policy write dispatched"), default);
				throw new Exception("Root policy protection bypassed");
			}
			catch (OperationException) { }
		}
		var nested = new NotificationHubTarget(new("hub", "team/alerts"), null);
		await gateway.ChangeAsync(change with
		{
			Target = nested,
			Action = "create",
			ExpectedRevision = null
		}, () => { }, default);
		Assert((await gateway.GetAsync(nested, default)).Settings!.RegistrationTtl == "90.00:00:00", "Nested hub names round trip");
		Assert(wire.RawPaths.Any(p => p.EndsWith("/notificationHubs/team%2Falerts", StringComparison.OrdinalIgnoreCase)), "Nested hub encoded as a single ARM parameter");
		Console.WriteLine("Notification Hubs adapter checks passed");
		return 0;
	}
}
