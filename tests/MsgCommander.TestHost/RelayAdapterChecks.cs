using System.Text.Json.Nodes;
using MsgCommander.Host;

static class RelayAdapterChecks
{
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}

	public static async Task<int> Run()
	{
		var wire = new RelayWire();
		await using var gateway = await FixtureRelayFactory.Connect(wire);
		var target = new RelayTarget(new("hybrid", "bridge"), null);
		var current = await gateway.GetAsync(target, default);
		wire.Data(RelayResourcePath.For(target))["properties"]!["listenerCount"] = 3;
		wire.Data(RelayResourcePath.For(target))["properties"]!["updatedAt"] = "2026-10-11T12:00:00Z";
		Assert((await gateway.GetAsync(target, default)).Revision == current.Revision, "Runtime changes do not invalidate revision");
		var change = new RelayChange(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, "update", current.Revision, current.Settings! with
		{
			UserMetadata = "changed"
		}, null, null, true);
		var dispatched = false;
		await gateway.ChangeAsync(change, () => dispatched = true, default);
		Assert(dispatched, "Reports write dispatch");
		var put = JsonNode.Parse(wire.Requests.Single(r => r.Method == "PUT").Body!)!["properties"]!;
		Assert(put["futureSetting"]!.GetValue<string>() == "preserved", "Unknown settings retained");
		Assert(put["listenerCount"] is null && put["createdAt"] is null && put["updatedAt"] is null, "Read-only fields omitted");
		Assert(put["userMetadata"]!.GetValue<string>() == "changed", "Metadata reaches wire");
		try
		{
			await gateway.ChangeAsync(change, () => throw new Exception("Stale write dispatched"), default);
			throw new Exception("Stale revision accepted");
		}
		catch (OperationException)
		{
		}

		Assert(wire.Requests.All(r => r.Path.Contains("api-version=2024-01-01")), "Pinned documented ARM version");
		var scope = new RelayScope("namespace", "");
		var page = await gateway.ListAsync(scope, "hybrid", null, default);
		Assert(page.Items.Count == 2 && page.ContinuationToken is not null, "Paging");
		Assert((await gateway.ListAsync(scope, "hybrid", page.ContinuationToken, default)).Items.Single().Target.Scope.Name == "more-bridge", "Next page");
		foreach (var next in new[]
		{
			"https://evil.invalid" + FixtureRelayFactory.Root + "/hybridConnections",
			"https://management.azure.com" + FixtureRelayFactory.Root + "/wcfRelays",
			"https://user@management.azure.com" + FixtureRelayFactory.Root + "/hybridConnections"
		}

		)
		{
			var count = wire.Requests.Count;
			try
			{
				await gateway.ListAsync(scope, "hybrid", next, default);
				throw new Exception("Unscoped continuation accepted");
			}
			catch (OperationException)
			{
			}

			Assert(count == wire.Requests.Count, "Rejected before sending credentials");
		}

		var wcf = new RelayTarget(new("wcf", "legacy"), null);
		var details = await gateway.GetAsync(wcf, default);
		Assert(details.Settings?.RelayType == "NetTcp" && details.Settings.RequiresTransportSecurity == true, "WCF fields projected");
		await gateway.ChangeAsync(change with
		{
			Id = Guid.NewGuid().ToString(),
			Target = wcf,
			ExpectedRevision = details.Revision,
			Settings = details.Settings! with
			{
				UserMetadata = "edited legacy"
			}
		}, () =>
		{
		}, default);
		Assert(wire.Data(RelayResourcePath.For(wcf))["properties"]!["relayType"]!.GetValue<string>() == "NetTcp", "WCF binding preserved");
		var nested = new RelayTarget(new("hybrid", "team/orders"), null);
		await gateway.ChangeAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), nested, "create", null, new("Nested", true, null, null), null, null, true), () =>
		{
		}, default);
		Assert((await gateway.GetAsync(nested, default)).Settings?.UserMetadata == "Nested", "Nested Relay names round trip");
		Assert(wire.RawPaths.Any(p => p.EndsWith("/hybridConnections/team%2Forders", StringComparison.OrdinalIgnoreCase)), "Nested Relay name encoded as a single ARM parameter");
		Console.WriteLine("Relay adapter checks passed");
		return 0;
	}
}
