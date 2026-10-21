using Azure;
using MsgCommander.Host;
using static MsgCommander.Application.ServiceBus.Rules.SubscriptionRules;

sealed partial class FixtureGateway
{
	private readonly Dictionary<string, Dictionary<string, RuleDefinition>> rules = [];
	private Dictionary<string, RuleDefinition> Rules(EntityTarget target)
	{
		Target(target);
		if (!entitySettings.ContainsKey(target))
			throw new RequestFailedException(404, "SECRET missing subscription");
		var key = EntityManagement.Path(target);
		if (!rules.TryGetValue(key, out var value))
			rules[key] = value = new(StringComparer.OrdinalIgnoreCase)
			{
				["$Default"] = new("true", "", [], null, "", [])
			};
		return value;
	}
	public Task<RulePage> ListRulesAsync(EntityTarget target, string? continuation, CancellationToken cancellation)
	{
		var offset = continuation is null ? 0 : int.Parse(continuation);
		var values = Rules(target).OrderBy(p => p.Key, StringComparer.Ordinal).ToArray();
		// Small pages exercise pagination without manufacturing hundreds of rules.
		return Task.FromResult(new RulePage(values.Skip(offset).Take(2).Select(p => new RuleSummary(p.Key, p.Value.FilterType, p.Value.ActionExpression.Length > 0)).ToArray(), offset + 2 < values.Length ? (offset + 2).ToString() : null));
	}
	public Task<RuleConfiguration> GetRuleAsync(EntityTarget target, string name, CancellationToken cancellation)
	{
		Target(target, name);
		if (!Rules(target).TryGetValue(name, out var rule))
			throw new RequestFailedException(404, "SECRET missing rule");
		return Task.FromResult(Configuration(name, rule));
	}
	public async Task ChangeRuleAsync(string action, EntityTarget target, string name, RuleDefinition? definition, string? expectedRevision, Action dispatching, CancellationToken cancellation)
	{
		Target(target, name);
		if (action != "delete")
			Validate(definition!);
		var values = Rules(target);
		if (action != "create")
			CheckRevision(await GetRuleAsync(target, name, cancellation), expectedRevision);
		if (definition?.ActionExpression == "SET slow = 'preflight'")
			await Task.Delay(10000, cancellation);
		cancellation.ThrowIfCancellationRequested();
		dispatching();
		if (target.TopicName!.StartsWith("copy-fail", StringComparison.Ordinal) && name == "failing-rule")
			throw new RequestFailedException(400, "SECRET fixture copy rule rejection");
		if (name == "denied-rule")
			throw new RequestFailedException(403, "SECRET forbidden");
		if (definition?.SqlExpression == "INVALID SQL")
			throw new RequestFailedException(400, "SECRET SQL details");
		if (name == "slow-rule")
			await Task.Delay(10000, cancellation);
		if (action == "create")
		{
			if (!values.TryAdd(name, definition!))
				throw new RequestFailedException(409, "SECRET duplicate");
		}
		else if (action == "update")
			values[name] = definition!;
		else if (action == "delete")
			values.Remove(name);
		else
			throw new OperationException(OperationFailure.InvalidInput, "Invalid rule action.");
		if (name == "commit-late-rule")
			await Task.Delay(150);
		if (name.StartsWith("unknown-rule", StringComparison.Ordinal) || definition?.ActionExpression == "SET outcome = 'unknown'")
			throw new IOException("SECRET lost acknowledgement");
	}
}
