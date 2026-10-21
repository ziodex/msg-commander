using MsgCommander.Host;

static class AuthorizationAdapterChecks
{
	public const string ResourceId = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.ServiceBus/namespaces/fixture";
	public static async Task<int> Run()
	{
		var gateway = new FixtureAuthorization(ResourceId);
		var wire = gateway.Wire;
		var dispatches = 0;
		foreach (var target in new[] { new AuthorizationTarget("namespace"), new("queue", "orders"), new("topic", "order-events"), new("queue", "nested/orders"), new("topic", "nested/events"), new("queue", "nested/providers/team/orders") })
		{
			await gateway.ChangeAsync("create", target, "app", ["Send"], null, null, () => dispatches++, default);
			var first = await gateway.GetAsync(target, "app", default);
			Assert(first.Rights.SequenceEqual(["Send"]), "Rights serialized in ARM properties");
			Assert(wire.KeyReads == 0, "Metadata paths never call listKeys");
			var primary = await gateway.KeyAsync(target, "app", "PrimaryKey", default);
			var secondary = await gateway.KeyAsync(target, "app", "SecondaryKey", default);
			await gateway.ChangeAsync("update", target, "app", ["Manage", "Listen", "Send"], first.Revision, null, () => dispatches++, default);
			Assert((await gateway.KeyAsync(target, "app", "PrimaryKey", default)).Key == primary.Key, "Editing rights preserves keys");
			var changed = await gateway.GetAsync(target, "app", default);
			var prior = dispatches;
			try
			{
				await gateway.ChangeAsync("delete", target, "app", null, first.Revision, null, () => dispatches++, default);
				throw new Exception("Accepted stale form");
			}
			catch (OperationException) { }
			Assert(dispatches == prior, "Stale request does not dispatch");
			await gateway.ChangeAsync("regenerate", target, "app", null, changed.Revision, "PrimaryKey", () => dispatches++, default);
			Assert((await gateway.KeyAsync(target, "app", "PrimaryKey", default)).Key != primary.Key, "Primary key rotated");
			Assert((await gateway.KeyAsync(target, "app", "SecondaryKey", default)).Key == secondary.Key, "Secondary key preserved");
			var afterPrimary = await gateway.KeyAsync(target, "app", "PrimaryKey", default);
			await gateway.ChangeAsync("regenerate", target, "app", null, changed.Revision, "SecondaryKey", () => dispatches++, default);
			Assert((await gateway.KeyAsync(target, "app", "PrimaryKey", default)).Key == afterPrimary.Key, "Primary slot preserved during secondary rotation");
			Assert((await gateway.KeyAsync(target, "app", "SecondaryKey", default)).Key != secondary.Key, "Secondary key rotated");
			if (target.Kind != "namespace")
				Assert(primary.ConnectionString.EndsWith("EntityPath=" + target.Name), "Entity connection string is scoped");
			await gateway.ChangeAsync("delete", target, "app", null, changed.Revision, null, () => dispatches++, default);
			Assert(!(await gateway.ListAsync(target, default)).Items.Any(r => r.Name == "app"), "Deletion scoped to rule");
			// Next scope must not inherit the previous scope's listKeys count.
			wire.KeyReads = 0;
		}
		Assert(dispatches == 30 && wire.Rotations == 12, "One write per explicit operation across six scope cases");
		Assert(wire.Policies.Count == 3, "Existing root and sibling policies preserved");
		Assert(wire.Requests.Where(r => r.Method == "PUT").All(r => !r.Body!.Contains("Key") && !r.Body.Contains("ConnectionString")), "Rights changes never serialize credential values");
		Assert(wire.Requests.Where(r => r.Path.EndsWith("regenerateKeys")).All(r => r.Body is "{\"keyType\":\"PrimaryKey\"}" or "{\"keyType\":\"SecondaryKey\"}"), "No custom key or second slot in regeneration request");
		wire.Paginate = true;
		wire.Policies[ResourceId + "/authorizationRules/other"] = new(["Listen"]);
		Assert((await gateway.ListAsync(new("namespace"), default)).Items.Count == 2, "Follows ARM paging without exposing a URL to the renderer");
		Assert(wire.Requests.Any(r => r.Path.Contains("queues/nested/orders/authorizationRules/app")), "Nested entity path stays within its ARM queue scope");
		wire.Policies[ResourceId + "/queues/nested/orders/authorizationRules/one"] = new(["Send"]);
		wire.Policies[ResourceId + "/queues/nested/orders/authorizationRules/two"] = new(["Listen"]);
		Assert((await gateway.ListAsync(new("queue", "nested/orders"), default)).Items.Count == 2, "Nested queue paging preserves the entity name");
		Console.WriteLine("Authorization adapter checks passed");
		return 0;
	}
	private static void Assert(bool condition, string message)
	{
		if (!condition)
			throw new Exception(message);
	}
}
