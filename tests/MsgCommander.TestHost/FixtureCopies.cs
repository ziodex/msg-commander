using Azure;
using MsgCommander.Host;
using static MsgCommander.Application.ServiceBus.Entities.EntityManagement;

sealed partial class FixtureGateway
{
	private readonly Dictionary<EntityTarget, string> copyIdentities = [];
	public async Task<EntityCopyState> GetEntityCopyStateAsync(EntityTarget target, CancellationToken cancellation)
	{
		var config = await GetEntityConfigurationAsync(target, cancellation);
		if (config.Settings.UserMetadata == "unsupported-copy")
			throw new OperationException(OperationFailure.UnsupportedOperation, "This entity contains unsupported copy fields.");
		if (!copyIdentities.TryGetValue(target, out var identity))
			copyIdentities[target] = identity = Guid.NewGuid().ToString();
		return new(config, identity);
	}
	public Task<bool> EntityExistsAsync(EntityTarget target, CancellationToken cancellation) => Task.FromResult(entitySettings.Keys.Any(t => (t.Kind == target.Kind || t.Kind != "subscription" && target.Kind != "subscription") && Path(t).Equals(Path(target), StringComparison.OrdinalIgnoreCase)));
	public async Task CreateEntityCopyAsync(EntityTarget target, EntitySettings settings, string guardRule, Action dispatching, CancellationToken cancellation)
	{
		Validate(target, settings);
		if (await EntityExistsAsync(target, cancellation))
			throw new RequestFailedException(409, "SECRET existing copy");
		if (target.Kind == "subscription" && !await EntityExistsAsync(new("topic", target.TopicName!), cancellation))
			throw new RequestFailedException(404, "SECRET missing parent");
		cancellation.ThrowIfCancellationRequested();
		dispatching();
		if (target.Name == "denied-copy")
			throw new RequestFailedException(403, "SECRET denied");
		entitySettings[target] = settings;
		removedEntities.Remove(target);
		copyIdentities[target] = Guid.NewGuid().ToString();
		Bucket(target, false);
		if (target.Kind == "subscription")
			rules[Path(target)] = new(StringComparer.OrdinalIgnoreCase)
			{
				[guardRule] = new("false", "", [], null, "", [])
			};
		if (target.Name == "slow-copy")
			await Task.Delay(10000, cancellation);
		if (target.Name == "unknown-copy")
			throw new IOException("SECRET acknowledgement lost");
	}
}
