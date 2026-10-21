using Azure;
using MsgCommander.Host;
using static MsgCommander.Application.ServiceBus.Entities.EntityManagement;

sealed partial class FixtureGateway
{
	private readonly Dictionary<EntityTarget, EntitySettings> entitySettings = SeedEntities();
	private readonly HashSet<EntityTarget> removedEntities = [];
	public static EntitySettings DefaultSettings(string kind) => new("Active", "unlimited", "disabled", true, "",
		kind != "topic" ? "00:01:00" : null, kind != "topic" ? 10 : null, kind != "topic" ? false : null, kind != "topic" ? "" : null, kind != "topic" ? "" : null, kind != "topic" ? false : null,
		kind != "subscription" ? 1024 : null, null, kind != "subscription" ? false : null, kind != "subscription" ? "00:10:00" : null, kind != "subscription" ? false : null, kind == "topic" ? false : null, kind == "subscription" ? true : null);
	private static Dictionary<EntityTarget, EntitySettings> SeedEntities()
	{
		Dictionary<EntityTarget, EntitySettings> result = [];
		foreach (var name in new[] { "orders", "sessions", "empty", "slow", "denied", "deleted", "large", "last-sequence", "budget", "oversized", "archive" })
			result[new("queue", name)] = DefaultSettings("queue") with
			{
				RequiresSession = name == "sessions"
			};
		result[new("topic", "order-events")] = DefaultSettings("topic");
		foreach (var name in new[] { "billing", "audit" })
			result[new("subscription", name, "order-events")] = DefaultSettings("subscription") with
			{
				RequiresSession = name == "audit"
			};
		return result;
	}
	private EntityPage ProjectEntityPage(EntityPage original, string kind, string? topic, string? continuation)
	{
		var items = original.Items.Where(item => !removedEntities.Contains(item.Target)).Select(item => entitySettings.TryGetValue(item.Target, out var s) ? new EntityInfo(item.Target, s.Status, s.RequiresSession) : item).ToList();
		if (continuation is null)
			foreach (var pair in entitySettings.Where(pair => pair.Key.Kind == kind && pair.Key.TopicName == topic && !SeedEntities().ContainsKey(pair.Key)))
				items.Add(new(pair.Key, pair.Value.Status, pair.Value.RequiresSession));
		return new(items, original.ContinuationToken);
	}
	public Task<EntityConfiguration> GetEntityConfigurationAsync(EntityTarget target, CancellationToken cancellation)
	{
		if (!entitySettings.TryGetValue(target, out var settings) || removedEntities.Contains(target))
			throw new RequestFailedException(404, "SECRET missing entity");
		return Task.FromResult(Configuration(target, settings));
	}
	public async Task ChangeEntityAsync(string action, EntityTarget target, EntitySettings? settings, string? expectedRevision, Action dispatching, CancellationToken cancellation)
	{
		ValidateTarget(target);
		if (action != "delete")
			Validate(target, settings!);
		if (action != "create")
		{
			var current = await GetEntityConfigurationAsync(target, cancellation);
			CheckRevision(current, expectedRevision);
			if (action == "update")
				CheckImmutable(current.Settings, settings!);
		}
		if (settings?.UserMetadata == "slow-preflight")
			await Task.Delay(10000, cancellation);
		if (action != "create" && target.Name == "bulk-wait-before")
			await Task.Delay(10000, cancellation);
		cancellation.ThrowIfCancellationRequested();
		dispatching();
		if (action != "create" && target.Name == "bulk-denied")
			throw new RequestFailedException(403, "SECRET bulk denied");
		if (action != "create" && target.Name == "bulk-wait-dispatched")
			await Task.Delay(10000, cancellation);
		if (target.Name == "denied-entity")
			throw new RequestFailedException(403, "SECRET permission denied");
		if (target.Name == "slow-entity")
			await Task.Delay(10000, cancellation);
		if (action == "create")
		{
			if (entitySettings.ContainsKey(target))
				throw new RequestFailedException(409, "SECRET already exists");
			if (target.Kind == "subscription" && !entitySettings.ContainsKey(new("topic", target.TopicName!)))
				throw new RequestFailedException(404, "SECRET parent missing");
			entitySettings.Add(target, settings!);
			removedEntities.Remove(target);
			copyIdentities[target] = Guid.NewGuid().ToString();
		}
		else if (action == "update")
			entitySettings[target] = settings!;
		else if (action == "delete")
		{
			foreach (var item in entitySettings.Keys.Where(item => Affects(target, item)).ToArray())
			{
				entitySettings.Remove(item);
				removedEntities.Add(item);
				messages.TryRemove(Key(item), out _);
				rules.Remove(EntityManagement.Path(item));
			}
		}
		else
			throw new OperationException(OperationFailure.InvalidInput, "Invalid action.");
		if (action == "delete" && target.Name == "copy-unknown-delete")
			throw new IOException("SECRET deletion acknowledgement lost");
		if (action != "create" && target.Name == "bulk-unknown")
			throw new IOException("SECRET bulk acknowledgement lost");
		if (action != "create" && target.Name == "bulk-commit-late")
			await Task.Delay(300);
		if (target.Name == "commit-late-entity")
			await Task.Delay(150);
		if (target.Name.StartsWith("unknown-entity", StringComparison.Ordinal) || settings?.UserMetadata == "unknown-update")
			throw new IOException("SECRET acknowledgement lost");
	}
}
