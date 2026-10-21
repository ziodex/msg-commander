using MsgCommander.Application.Common;
using MsgCommander.Application.AccessPolicies;
using MsgCommander.Application.ResourceConfiguration;
using MsgCommander.Application.ServiceBus.Gateways;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Application.ServiceBus.Rules;
using MsgCommander.Application.ServiceBus.Authorization;
using MsgCommander.Contracts.ResourceConfiguration;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Rules;
using MsgCommander.Contracts.ServiceBus.Authorization;
using System.Text.Json;
namespace MsgCommander.Application.ServiceBus.Configuration;

public sealed class ServiceBusConfigurationGateway(IServiceBusAdministrationGateway gateway, string ns, Func<IAuthorizationGateway?> authorization, Func<string> context, IConfigurationFailureClassifier failures, Action? requireWritable = null) : IMessagingConfigurationGateway
{
	public string Service => "service-bus"; public string Namespace => ns; public string ContextKey => context();
	private IAuthorizationGateway Auth => authorization() ?? throw new OperationException(OperationFailure.InvalidInput, "Connect Azure management before importing or exporting Service Bus policy rights. Resource settings can be migrated separately.");
	private static AuthorizationTarget PolicyScope(MessagingConfigTarget target) => new(target.ParentKind!, target.ParentKind == "namespace" ? null : target.ParentName);
	public async Task<MessagingConfigSnapshot> Read(MessagingConfigTarget target, CancellationToken token)
	{
		if (target.Kind == "policy")
		{
			var rule = await Auth.GetAsync(PolicyScope(target), target.Name, token);
			return new(new(target, MessagingConfiguration.Value(new
			{
				rights = rule.Rights
			}), false, null), rule.Revision, "");
		}
		if (target.Kind == "rule")
		{
			var rule = await gateway.GetRuleAsync(target.Entity(), target.Name, token);
			if (rule.ReadOnlyReason is not null)
				throw new OperationException(OperationFailure.InvalidInput, "An existing rule has unsupported fields. Review it separately; nothing will be replaced.");
			return new(new(target, MessagingConfiguration.Value(rule.Definition), false, null), rule.Revision, "");
		}
		var state = await gateway.GetEntityCopyStateAsync(target.Entity(), token);
		return new(new(target, MessagingConfiguration.Value(state.Configuration.Settings), target.Kind == "subscription", null), state.Configuration.Revision, state.Identity);
	}
	private async Task<IReadOnlyList<MessagingConfigTarget>> List(string kind, string? parent, CancellationToken token)
	{
		List<MessagingConfigTarget> rows = [];
		HashSet<string> seen = [];
		string? next = null;
		do
		{
			var page = await gateway.ListAsync(kind, parent, next, token);
			rows.AddRange(page.Items.Select(i => new MessagingConfigTarget(i.Target.Kind, i.Target.Name, i.Target.Kind == "subscription" ? "topic" : null, i.Target.TopicName)));
			next = page.ContinuationToken;
			if (rows.Count > 100 || next is not null && !seen.Add(next))
				throw new OperationException(OperationFailure.OperationBlocked, "Resource listing exceeds 100 targets or repeated a continuation. Export a smaller scope.");
		} while (next is not null);
		return rows;
	}
	private async Task<IReadOnlyList<RuleConfiguration>> Rules(MessagingConfigTarget subscription, CancellationToken token)
	{
		List<RuleConfiguration> rules = [];
		HashSet<string> pages = [], names = new(StringComparer.OrdinalIgnoreCase);
		string? next = null;
		do
		{
			var page = await gateway.ListRulesAsync(subscription.Entity(), next, token);
			foreach (var summary in page.Items)
			{
				if (!names.Add(summary.Name) || rules.Count >= 100)
					throw MessagingConfiguration.Invalid();
				rules.Add(await gateway.GetRuleAsync(subscription.Entity(), summary.Name, token));
			}
			next = page.ContinuationToken;
			if (next is not null && !pages.Add(next))
				throw MessagingConfiguration.Invalid();
		} while (next is not null);
		return rules;
	}
	public async Task<IReadOnlyList<string>> RuleNames(MessagingConfigTarget target, CancellationToken token) => (await Rules(target, token)).Select(r => r.Name).ToArray();
	public async Task<IReadOnlyList<MessagingConfigSnapshot>> ForwardingTree(MessagingConfigTarget target, CancellationToken token)
	{
		var seen = new Dictionary<string, MessagingConfigSnapshot>();
		async Task Walk(MessagingConfigTarget current, int depth)
		{
			if (seen.ContainsKey(current.Key()))
				return;
			if (seen.Count >= 100 || depth > 5)
				throw new OperationException(OperationFailure.InvalidInput, "Forwarding dependency graph exceeds the bounded depth/target limit. Review the destination topology separately.");
			var state = await Read(current, token);
			seen.Add(current.Key(), state);
			if (current.Kind == "topic")
			{
				foreach (var sub in await List("subscription", current.Name, token))
					await Walk(sub, depth);
				return;
			}
			var s = state.Resource.Settings.Deserialize<EntitySettings>(MessagingConfiguration.Json)!;
			foreach (var name in new[] { s.ForwardTo, s.ForwardDeadLetteredMessagesTo }.Where(n => !string.IsNullOrEmpty(n)).Distinct(StringComparer.OrdinalIgnoreCase))
			{
				var q = new MessagingConfigTarget("queue", name!, null, null);
				var t = new MessagingConfigTarget("topic", name!, null, null);
				if (await gateway.EntityExistsAsync(q.Entity(), token))
				{
					// Resolve the actual resource kind with a typed read.
					try
					{
						await Walk(q, depth + 1);
						continue;
					}
					catch (Exception error) when (failures.Classify(error).IsNotFound) { }
				}
				await Walk(t, depth + 1);
			}
		}
		await Walk(target, 0);
		return seen.Values.ToArray();
	}
	public async Task VerifyRules(MessagingConfigTarget target, IReadOnlyList<MessagingConfigResource> intended, CancellationToken token)
	{
		var current = await Rules(target, token);
		if (current.Count != intended.Count || current.Any(r => r.ReadOnlyReason is not null || !intended.Any(p => p.Target.Name.Equals(r.Name, StringComparison.OrdinalIgnoreCase) && JsonSerializer.Serialize(r.Definition, MessagingConfiguration.Json) == p.Settings.GetRawText())))
			throw new OperationException(OperationFailure.RevisionConflict, "Subscription rules differ from the reviewed import. The subscription remains disabled; inspect its rules before enabling it.");
	}
	public async Task<IReadOnlyList<MessagingConfigResource>> Export(MessagingConfigTarget? scope, bool policies, CancellationToken token)
	{
		List<MessagingConfigResource> rows = [];
		async Task Add(MessagingConfigTarget target, bool children = true)
		{
			rows.Add((await Read(target, token)).Resource);
			if (target.Kind == "topic" && children)
				foreach (var child in await List("subscription", target.Name, token))
					await Add(child);
			if (target.Kind == "subscription")
				foreach (var rule in await Rules(target, token))
				{
					if (rule.ReadOnlyReason is not null)
						throw new OperationException(OperationFailure.InvalidInput, "A selected rule cannot be exported without losing settings. No partial file was saved.");
					rows.Add(new(new("rule", rule.Name, "subscription", $"{target.ParentName}/Subscriptions/{target.Name}"), MessagingConfiguration.Value(rule.Definition), false, null));
				}
			if (policies && target.Kind is "queue" or "topic")
				foreach (var p in (await Auth.ListAsync(new(target.Kind, target.Name), token)).Items)
					rows.Add(new(new("policy", p.Name, target.Kind, target.Name), MessagingConfiguration.Value(new
					{
						rights = p.Rights
					}), false, null));
			if (rows.Count > 100)
				throw new OperationException(OperationFailure.OperationBlocked, "Configuration exceeds 100 targets. Export a smaller scope.");
		}
		if (scope is null)
		{
			foreach (var kind in new[] { "queue", "topic" })
				foreach (var target in await List(kind, null, token))
					await Add(target);
			if (policies)
				foreach (var p in (await Auth.ListAsync(new("namespace"), token)).Items)
					rows.Add(new(new("policy", p.Name, "namespace", ""), MessagingConfiguration.Value(new
					{
						rights = p.Rights
					}), false, null));
		}
		else
		{
			if (scope.Kind == "subscription")
				await Add(scope.Parent()!, false);
			await Add(scope);
		}
		return rows;
	}
	public Task<MessagingConfigResource> Prepare(MessagingConfigResource source, MessagingConfigSnapshot? current, CancellationToken token)
	{
		var target = source.Target;
		JsonElement prepared;
		if (target.Kind == "policy")
		{
			_ = Auth;
			var rights = AccessPolicyRules.Rights(source.Settings.GetProperty("rights").Deserialize<string[]>(MessagingConfiguration.Json));
			prepared = MessagingConfiguration.Value(new
			{
				rights
			});
		}
		else if (target.Kind == "rule")
		{
			var rule = source.Settings.Deserialize<RuleDefinition>(MessagingConfiguration.Json)!;
			SubscriptionRules.Validate(rule);
			prepared = MessagingConfiguration.Value(rule);
		}
		else
		{
			prepared = MessagingConfiguration.Merge(current?.Resource.Settings ?? MessagingConfiguration.Value(MessagingConfiguration.DefaultEntity(target.Kind)), source.Settings);
			var settings = prepared.Deserialize<EntitySettings>(MessagingConfiguration.Json)!;
			EntityManagement.Validate(target.Entity(), settings);
			if (current is not null)
				EntityManagement.CheckImmutable(current.Resource.Settings.Deserialize<EntitySettings>(MessagingConfiguration.Json)!, settings);
		}
		return Task.FromResult(source with
		{
			Settings = prepared
		});
	}
	public async Task Write(MessagingConfigResource resource, string phase, string action, MessagingConfigSnapshot? current, string? guard, Action dispatching, CancellationToken token)
	{
		requireWritable?.Invoke();
		var target = resource.Target;
		if (target.Kind == "policy")
		{
			await Auth.ChangeAsync(action, PolicyScope(target), target.Name, resource.Settings.GetProperty("rights").Deserialize<string[]>(MessagingConfiguration.Json), current?.Revision, null, dispatching, token);
			return;
		}
		if (target.Kind == "rule")
		{
			if (phase == "remove-guard")
			{
				var rule = await gateway.GetRuleAsync(target.Entity(), target.Name, token);
				if (rule.Definition.FilterType != "false" || rule.Definition.ActionExpression.Length != 0)
					throw new OperationException(OperationFailure.RevisionConflict, "The temporary import filter changed. Inspect this disabled subscription before proceeding.");
				await gateway.ChangeRuleAsync("delete", target.Entity(), target.Name, null, rule.Revision, dispatching, token);
			}
			else
				await gateway.ChangeRuleAsync(action, target.Entity(), target.Name, resource.Settings.Deserialize<RuleDefinition>(MessagingConfiguration.Json), current?.Revision, dispatching, token);
			return;
		}
		var settings = resource.Settings.Deserialize<EntitySettings>(MessagingConfiguration.Json)!;
		if (target.Kind == "subscription" && action == "create")
			await gateway.CreateEntityCopyAsync(target.Entity(), settings, guard!, dispatching, token);
		else
			await gateway.ChangeEntityAsync(action, target.Entity(), settings, current?.Revision, dispatching, token);
	}
}
