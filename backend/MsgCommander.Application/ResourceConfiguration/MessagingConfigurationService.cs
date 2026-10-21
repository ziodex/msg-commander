using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.ResourceConfiguration;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Domain.Common;
using MsgCommander.Domain.ResourceConfiguration;
using MsgCommander.Domain.ServiceBus.Entities;

namespace MsgCommander.Application.ResourceConfiguration;

/// <summary>A connection-owned configuration review and receipt service. Calls require owner serialization.</summary>
public sealed class MessagingConfigurationService(IMessagingConfigurationGateway gateway, IConfigurationFailureClassifier failures)
{
	public void Clear()
	{
		plan = null;
		receipts.Clear();
	}
	public string Service => gateway.Service;
	private sealed record Planned(MessagingConfigEntry Entry, MessagingConfigResource Resource, MessagingConfigSnapshot? Expected, string? Guard);
	private sealed record Plan(MessagingConfigPreview Preview, string Context, DateTimeOffset Expires, IReadOnlyDictionary<string, Planned> Steps, IReadOnlyDictionary<string, (MessagingConfigTarget Target, MessagingConfigSnapshot? State)> Dependencies);
	private Plan? plan;
	private readonly Dictionary<string, (string Fingerprint, MessagingConfigResult Result)> receipts = [];
	private static bool Same(MessagingConfigSnapshot? left, MessagingConfigSnapshot? right) => left?.Revision == right?.Revision && left?.Identity == right?.Identity;
	private async Task<MessagingConfigSnapshot?> Read(MessagingConfigTarget target, CancellationToken token)
	{
		try
		{
			return await gateway.Read(target, token);
		}
		catch (Exception error) when (failures.Classify(error).IsNotFound) { return null; }
	}
	private void RequireService(string service)
	{
		if (service != gateway.Service)
			throw MessagingConfiguration.Invalid();
	}
	private static CancellationTokenSource Budget(CancellationToken cancellation)
	{
		var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
		deadline.CancelAfter(TimeSpan.FromMinutes(2));
		return deadline;
	}
	public MessagingConfigResult? GetResult(string service, string operationId)
	{
		RequireService(service);
		return receipts.TryGetValue(operationId, out var receipt) ? receipt.Result : null;
	}
	public void Discard(string service)
	{
		RequireService(service);
		plan = null;
	}
	public async Task<MessagingConfigExport> ExportAsync(MessagingConfigExportRequest request, CancellationToken cancellation)
	{
		RequireService(request.Service);
		using var deadline = Budget(cancellation);
		var token = deadline.Token;
		var scope = request.Scope;
		scope?.Validate(gateway.Service);
		if (scope?.Kind is "policy" or "rule" || request.Format != "json")
			throw MessagingConfiguration.Invalid();
		var resources = (await gateway.Export(scope, request.IncludePolicies, token)).ToArray();
		var warnings = new List<string> { "SAS keys, credentials, messages and event data are excluded. New policies get new keys; existing policy keys are preserved." };
		if (!request.IncludePolicies)
			warnings.Add("Policy rights were excluded by the export selection.");
		if (gateway.Service == "event-hubs")
			warnings.Add("Capture destinations and identities are excluded. Existing destination Capture is preserved; configure new hub Capture separately.");
		var archive = new MessagingConfigArchive(MessagingConfiguration.Format, 1, gateway.Service,
			MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow), gateway.Namespace, resources, warnings);
		var bytes = MessagingConfiguration.Encode(archive, request.Format);
		token.ThrowIfCancellationRequested();
		return new(Convert.ToBase64String(bytes), resources.Length, warnings);
	}
	public async Task<MessagingConfigPreview> PreviewAsync(MessagingConfigPreviewRequest request, CancellationToken cancellation)
	{
		RequireService(request.Service);
		using var deadline = Budget(cancellation);
		return await Preview(request.ContentBase64, deadline.Token);
	}
	public async Task<MessagingConfigResult> ApplyAsync(MessagingConfigApply request, string fingerprint, Func<MessagingConfigProgress, Task> emit, CancellationToken cancellation)
	{
		RequireService(request.Service);
		using var deadline = Budget(cancellation);
		return await Apply(request, fingerprint, emit, deadline.Token);
	}
	private async Task<MessagingConfigPreview> Preview(string contentBase64, CancellationToken token)
	{
		plan = null;
		var archive = MessagingConfiguration.Decode(contentBase64, gateway.Service);
		var resources = archive.Resources.ToList();
		var entries = new List<MessagingConfigEntry>();
		var steps = new Dictionary<string, Planned>();
		var dependencies = new Dictionary<string, (MessagingConfigTarget, MessagingConfigSnapshot?)>();
		var baseEntries = new Dictionary<string, MessagingConfigEntry>();
		var snapshots = new Dictionary<string, MessagingConfigSnapshot?>();
		var warnings = archive.Warnings.ToList();
		void Warn(string text)
		{
			if (warnings.Count < 100 && !warnings.Contains(text))
				warnings.Add(text);
		}
		async Task<MessagingConfigSnapshot?> Snapshot(MessagingConfigTarget target)
		{
			if (!snapshots.TryGetValue(target.Key(), out var value))
			{
				value = await Read(target, token);
				snapshots.Add(target.Key(), value);
			}
			return value;
		}
		async Task Depend(MessagingConfigTarget target)
		{
			dependencies[target.Key()] = (target, await Snapshot(target));
		}
		MessagingConfigEntry Add(MessagingConfigResource resource, string phase, string action, MessagingConfigSnapshot? current, IEnumerable<string> depends, string? issue, string? guard = null)
		{
			var entry = new MessagingConfigEntry(Guid.NewGuid().ToString(), resource.Target, phase, issue is null ? action : "blocked", issue is null ? resource.Settings : MessagingConfiguration.Value(new
			{
			}), current?.Resource.Settings, depends.Distinct().ToArray(), issue);
			entries.Add(entry);
			steps.Add(entry.Id, new(entry, resource, current, guard));
			return entry;
		}
		int Order(MessagingConfigResource r) => r.Target.Kind switch
		{
			"queue" or "topic" or "hub" => 0,
			"subscription" or "group" => 1,
			"rule" => 2,
			_ => 3
		};
		foreach (var source in resources.OrderBy(Order).ThenBy(r => r.Target.Key(), StringComparer.Ordinal).ToArray())
		{
			token.ThrowIfCancellationRequested();
			var target = source.Target;
			MessagingConfigSnapshot? current = null;
			string? issue = source.Issue;
			try
			{
				current = await Snapshot(target);
			}
			catch (OperationException e) { issue = e.Message; }
			var depends = new List<string>();
			if (target.Parent() is { } parent)
			{
				if (baseEntries.TryGetValue(parent.Key(), out var p))
				{
					if (p.Action == "create")
						depends.Add(p.Id);
					if (p.Issue is not null)
						issue = "The parent resource is blocked; review it before importing this child.";
				}
				else
				{
					await Depend(parent);
					if (await Snapshot(parent) is null)
						issue = "The required parent is absent from the destination and this file.";
				}
			}
			var prepared = source;
			if (issue is null && current is not null && target.Kind == "subscription" && source.RulesSpecified)
			{
				var names = resources.Where(r => r.Target.Kind == "rule" && r.Target.Parent()?.Key() == target.Key()).Select(r => r.Target.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
				if ((await gateway.RuleNames(target, token)).Any(n => !names.Contains(n)))
					issue = "Existing subscription rules absent from this file would remain active. Review or remove those rules separately before importing this subscription.";
			}
			if (issue is null)
				try
				{
					prepared = await gateway.Prepare(source, current, token);
					issue = prepared.Issue;
				}
				catch (OperationException e) { issue = e.Message; }
			var action = current is null ? "create" : "update";
			if (target.Kind == "group" && target.Name == "$Default")
				action = "update";
			if (target.Kind == "policy" && target.ParentKind == "namespace" && target.Name.Equals("RootManageSharedAccessKey", StringComparison.OrdinalIgnoreCase) && (!prepared.Settings.TryGetProperty("rights", out var rights) || !rights.EnumerateArray().Any(r => r.GetString() == "Manage")))
				issue = "Keep the namespace root policy and its Manage rights.";
			var original = prepared;
			string? guard = null;
			if (issue is null && target.Kind is "queue" or "subscription")
			{
				var entity = prepared.Settings.Deserialize<EntitySettings>(MessagingConfiguration.Json)!;
				var old = current?.Resource.Settings.Deserialize<EntitySettings>(MessagingConfiguration.Json);
				prepared = prepared with
				{
					Settings = MessagingConfiguration.Value(entity with
					{
						ForwardTo = old?.ForwardTo ?? "",
						ForwardDeadLetteredMessagesTo = old?.ForwardDeadLetteredMessagesTo ?? "",
						Status = target.Kind == "subscription" && current is null ? "Disabled" : entity.Status
					})
				};
			}
			if (target.Kind == "subscription" && current is null)
			{
				guard = "commander-import-" + Guid.NewGuid().ToString("N");
				Warn("New subscriptions are created disabled with a temporary false filter. Selected rules are installed before removing that filter and applying the reviewed status.");
				if (!source.RulesSpecified && !resources.Any(r => r.Target.Parent()?.Key() == target.Key() && r.Target.Kind == "rule"))
				{
					// Upstream supplies its default match-all rule when no rules section was exported.
					resources.Add(new(new("rule", "$Default", "subscription", $"{target.ParentName}/Subscriptions/{target.Name}"), MessagingConfiguration.Value(MessagingConfiguration.MatchAll), false, null));
					Warn("A new subscription without a Rules section gets a reviewed $Default match-all rule, matching Explorer. Existing subscription rules are preserved.");
				}
			}
			var entry = Add(prepared, "resource", action, current, depends, issue, guard);
			baseEntries.Add(target.Key(), entry);
			// Forwarding is always a distinct step, after all entity creation and before activation/policies.
			if (issue is null && target.Kind is "queue" or "subscription" &&
				(original.Settings.GetProperty("forwardTo").GetString() != prepared.Settings.GetProperty("forwardTo").GetString() || original.Settings.GetProperty("forwardDeadLetteredMessagesTo").GetString() != prepared.Settings.GetProperty("forwardDeadLetteredMessagesTo").GetString()))
			{
				var full = original.Settings.Deserialize<EntitySettings>(MessagingConfiguration.Json)!;
				var linkDepends = new List<string> { entry.Id };
				string? linkIssue = null;
				foreach (var destination in new[] { full.ForwardTo, full.ForwardDeadLetteredMessagesTo }.Where(v => !string.IsNullOrEmpty(v)).Distinct(StringComparer.OrdinalIgnoreCase))
				{
					var candidates = resources.Where(r => r.Target.Kind is "queue" or "topic" && r.Target.Name.Equals(destination, StringComparison.OrdinalIgnoreCase)).ToArray();
					if (candidates.Length > 1)
					{
						linkIssue = "A forwarding destination is ambiguous between queue and topic.";
						continue;
					}
					if (candidates.Length == 1)
						continue; // Resolve its entry after every base resource is known.
					var q = new MessagingConfigTarget("queue", destination!, null, null);
					var t = new MessagingConfigTarget("topic", destination!, null, null);
					var qs = await Snapshot(q);
					var ts = await Snapshot(t);
					if ((qs is null) == (ts is null))
						linkIssue = "A forwarding destination is missing or ambiguous. Include it in the file or create it before importing.";
					else
						await Depend(qs is not null ? q : t);
				}
				var linkSettings = full with
				{
					Status = prepared.Settings.GetProperty("status").GetString()!
				};
				Add(original with
				{
					Settings = MessagingConfiguration.Value(linkSettings)
				}, "forwarding", "update", current, linkDepends, linkIssue);
			}
		}
		// Add synthesized default rules after their parent entries are available.
		foreach (var source in resources.Where(r => !baseEntries.ContainsKey(r.Target.Key())))
		{
			var parent = baseEntries[source.Target.Parent()!.Key()];
			var current = await Snapshot(source.Target);
			var prepared = await gateway.Prepare(source, current, token);
			var entry = Add(prepared, "resource", current is null ? "create" : "update", current, [parent.Id], parent.Issue);
			baseEntries.Add(source.Target.Key(), entry);
		}
		foreach (var sub in entries.Where(e => e.Target.Kind == "subscription" && e.Action == "create" && e.Phase == "resource").ToArray())
		{
			var state = steps[sub.Id];
			var source = resources.Single(r => r.Target.Key() == sub.Target.Key());
			var prepared = await gateway.Prepare(source, null, token);
			var rules = entries.Where(e => e.Target.Kind == "rule" && e.Target.Parent()?.Key() == sub.Target.Key()).ToArray();
			var guardTarget = new MessagingConfigTarget("rule", state.Guard!, "subscription", $"{sub.Target.ParentName}/Subscriptions/{sub.Target.Name}");
			var cleanup = Add(new(guardTarget, MessagingConfiguration.Value(new
			{
			}), false, null), "remove-guard", "delete", null, rules.Select(r => r.Id).Append(sub.Id), rules.Any(r => r.Issue is not null) ? "A source rule is blocked. The subscription cannot be activated with an incomplete rule set." : null);
			var forward = entries.SingleOrDefault(e => e.Target.Key() == sub.Target.Key() && e.Phase == "forwarding");
			Add(prepared, "activate", "update", null, forward is null ? [cleanup.Id] : [cleanup.Id, forward.Id], cleanup.Issue);
		}
		// Resolve forwarding dependencies, including cycles among imported queues.
		foreach (var entry in entries.Where(e => e.Phase == "forwarding" && e.Issue is null).ToArray())
		{
			var settings = entry.Proposed.Deserialize<EntitySettings>(MessagingConfiguration.Json)!;
			var needed = entry.DependsOn.ToList();
			var issue = entry.Issue;
			foreach (var name in new[] { settings.ForwardTo, settings.ForwardDeadLetteredMessagesTo }.Where(v => !string.IsNullOrEmpty(v)))
			{
				var destination = baseEntries.Values.SingleOrDefault(e => e.Target.Kind is "queue" or "topic" && e.Target.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
				if (destination is not null)
				{
					if (destination.Action == "create")
						needed.Add(destination.Id);
					if (destination.Issue is not null)
						issue = "The forwarding destination is blocked.";
				}
			}
			var updated = entry with
			{
				DependsOn = needed.Distinct().ToArray(),
				Issue = issue,
				Action = issue is null ? entry.Action : "blocked"
			};
			entries[entries.IndexOf(entry)] = updated;
			steps[entry.Id] = steps[entry.Id] with
			{
				Entry = updated
			};
		}
		foreach (var forward in entries.Where(e => e.Phase == "forwarding" && e.Issue is null))
		{
			var settings = forward.Proposed.Deserialize<EntitySettings>(MessagingConfiguration.Json)!;
			foreach (var name in new[] { settings.ForwardTo, settings.ForwardDeadLetteredMessagesTo }.Where(n => !string.IsNullOrEmpty(n)).Distinct(StringComparer.OrdinalIgnoreCase))
			{
				var candidate = resources.SingleOrDefault(r => r.Target.Kind is "queue" or "topic" && r.Target.Name.Equals(name, StringComparison.OrdinalIgnoreCase))?.Target;
				if (candidate is null)
				{
					var q = new MessagingConfigTarget("queue", name!, null, null);
					candidate = await Snapshot(q) is not null ? q : new("topic", name!, null, null);
				}
				if (await Snapshot(candidate) is not null)
					foreach (var state in await gateway.ForwardingTree(candidate, token))
					{
						dependencies[state.Resource.Target.Key()] = (state.Resource.Target, state);
						if (dependencies.Count > 100)
							throw new OperationException(OperationFailure.OperationBlocked, "Forwarding dependency discovery exceeds 100 targets. Import a smaller scope.");
					}
			}
		}
		var existingLinks = dependencies.Values.Where(p => p.Item2?.Resource.Target.Kind is "queue" or "subscription" && !entries.Any(e => e.Phase == "forwarding" && e.Target.Key() == p.Item1.Key()))
			.Select(p => new MessagingConfigEntry("", p.Item1, "forwarding", "update", p.Item2!.Resource.Settings, null, [], null));
		ValidateForwarding(entries.Concat(existingLinks).ToArray());
		if (entries.Count > 300 || JsonSerializer.SerializeToUtf8Bytes(entries, MessagingConfiguration.Json).Length > 786432)
			throw new OperationException(OperationFailure.OperationBlocked, "Configuration review exceeds 300 steps or 768 KiB. Select a smaller file.");
		var expires = DateTimeOffset.UtcNow.AddMinutes(10);
		var preview = new MessagingConfigPreview(Guid.NewGuid().ToString(), gateway.Service, archive.SourceNamespace, gateway.Namespace, MsgCommander.Application.Common.DisplayValues.Timestamp(expires), entries, warnings);
		token.ThrowIfCancellationRequested();
		plan = new(preview, gateway.ContextKey, expires, steps, dependencies);
		return preview;
	}
	private static void ValidateForwarding(IReadOnlyList<MessagingConfigEntry> entries)
	{
		var routes = entries.Where(entry => entry.Phase == "forwarding" && entry.Issue is null).Select(entry =>
		{
			var settings = entry.Proposed.Deserialize<EntitySettings>(MessagingConfiguration.Json)!;
			return new ForwardingRoute(entry.Target.Key(), entry.Target.Kind, entry.Target.Name, entry.Target.ParentName,
				settings.ForwardTo, settings.ForwardDeadLetteredMessagesTo);
		}).ToArray();
		DomainValidation.Check(() => ForwardingGraph.Validate(routes));
	}
	private async Task<MessagingConfigResult> Apply(MessagingConfigApply request, string fingerprint, Func<MessagingConfigProgress, Task> emit, CancellationToken token)
	{
		if (!Guid.TryParse(request.Id, out _) || !request.Acknowledged || request.Service != gateway.Service || request.EntryIds is null || request.EntryIds.Count is < 1 or > 300 || request.EntryIds.Distinct().Count() != request.EntryIds.Count)
			throw MessagingConfiguration.Invalid();
		if (receipts.TryGetValue(request.Id, out var prior))
		{
			if (prior.Fingerprint != fingerprint)
				throw new OperationException(OperationFailure.InvalidInput, "Import operation ID belongs to another request.");
			return prior.Result;
		}
		if (receipts.Count >= 20)
			throw new OperationException(OperationFailure.OperationBlocked, "Configuration receipt limit reached. Reconnect after reviewing results.");
		var pending = plan;
		if (pending is null || pending.Preview.ImportId != request.ImportId || pending.Expires < DateTimeOffset.UtcNow || pending.Context != gateway.ContextKey)
			throw new OperationException(OperationFailure.InvalidInput, "Configuration review expired or management access changed. Select the file again.");
		if (request.EntryIds.Any(id => !pending.Steps.ContainsKey(id) || pending.Steps[id].Entry.Issue is not null))
			throw new OperationException(OperationFailure.InvalidInput, "A selected configuration step is unavailable or blocked.");
		var selected = request.EntryIds.Select(id => pending.Steps[id]).ToArray();
		var ids = request.EntryIds.ToHashSet();
		if (selected.Any(s => s.Entry.DependsOn.Any(id => !ids.Contains(id))))
			throw new OperationException(OperationFailure.InvalidInput, "Include all required parent, rule, forwarding and activation dependencies before applying.");
		// An imported subscription must not be left disabled simply because its activation was unchecked.
		foreach (var sub in selected.Where(s => s.Resource.Target.Kind == "subscription" && s.Entry.Action == "create"))
			if (!selected.Any(s => s.Resource.Target.Key() == sub.Resource.Target.Key() && s.Entry.Phase == "activate"))
				throw new OperationException(OperationFailure.InvalidInput, "Include the new subscription's rule cleanup and final status steps.");
		foreach (var created in selected.Where(s => s.Entry.Action == "create"))
			if (pending.Preview.Entries.Any(e => e.Target.Key() == created.Resource.Target.Key() && e.Phase == "forwarding" && !ids.Contains(e.Id)))
				throw new OperationException(OperationFailure.InvalidInput, "Include the forwarding step required by this new resource.");
		var expected = new Dictionary<string, MessagingConfigSnapshot?>();
		foreach (var step in selected.DistinctBy(s => s.Resource.Target.Key()))
		{
			if (!Same(await Read(step.Resource.Target, token), step.Expected))
				throw new OperationException(OperationFailure.RevisionConflict, "Destination configuration changed after review. Nothing was written; import again.");
			expected[step.Resource.Target.Key()] = step.Expected;
		}
		foreach (var (target, state) in pending.Dependencies.Values)
			if (!Same(await Read(target, token), state))
				throw new OperationException(OperationFailure.RevisionConflict, "A parent or forwarding destination changed after review. Nothing was written; import again.");
		plan = null;
		List<Planned> ordered;
		int Phase(Planned s) => s.Entry.Phase switch
		{
			"forwarding" => 2,
			"remove-guard" => 3,
			"activate" => 4,
			_ => s.Resource.Target.Kind == "policy" ? 5 : s.Resource.Target.Kind == "rule" ? 1 : 0
		};
		try
		{
			var sequence = ImportDependencies.Order(selected.Select(step => new ImportDependencyStep(step.Entry.Id, step.Entry.DependsOn, Phase(step), step.Resource.Target.Key())).ToArray());
			var byId = selected.ToDictionary(step => step.Entry.Id);
			ordered = sequence.Select(id => byId[id]).ToList();
		}
		catch (DomainRuleException) { throw MessagingConfiguration.Invalid(); }
		var outcomes = ordered.Select(s => new MessagingConfigStep(s.Entry.Id, s.Resource.Target, s.Entry.Phase, "not-attempted", "Not attempted.")).ToArray();
		var status = "completed";
		string? stopReason = null;
		for (var index = 0; index < ordered.Count; index++)
		{
			var step = ordered[index];
			var dispatched = false;
			var writeCompleted = false;
			try
			{
				token.ThrowIfCancellationRequested();
				var current = await Read(step.Resource.Target, token);
				var ownedGuard = step.Entry.Phase == "remove-guard";
				var builtinGroup = step.Resource.Target.Kind == "group" && step.Resource.Target.Name == "$Default" && step.Expected is null;
				if (!ownedGuard && !builtinGroup && !Same(current, expected[step.Resource.Target.Key()]))
					throw new OperationException(OperationFailure.RevisionConflict, "Destination changed during import. Review the confirmed steps and import again.");
				if (step.Entry.Phase == "activate")
					await gateway.VerifyRules(step.Resource.Target, selected.Where(s => s.Resource.Target.Kind == "rule" && s.Resource.Target.Parent()?.Key() == step.Resource.Target.Key() && s.Entry.Phase == "resource").Select(s => s.Resource).ToArray(), token);
				await gateway.Write(step.Resource, step.Entry.Phase, step.Entry.Action, current, step.Guard, () => dispatched = true, token);
				writeCompleted = true;
				expected[step.Resource.Target.Key()] = step.Entry.Phase == "remove-guard" ? null : await Read(step.Resource.Target, token);
				outcomes[index] = outcomes[index] with
				{
					Status = "confirmed",
					Summary = "Change confirmed."
				};
				// Creating the subscription also creates our temporary guard, not any source rule.
				try
				{
					await emit(new(request.Id, (index + 1) * 100 / ordered.Count, $"Configuration import: {index + 1}/{ordered.Count} steps confirmed."));
				}
				catch
				{
					status = token.IsCancellationRequested ? "cancelled" : "failed";
					stopReason = "Progress delivery stopped after this change was confirmed. Remaining steps were not attempted.";
					break;
				}
			}
			catch (Exception error)
			{
				var rejected = error is OperationException or ArgumentException or UnauthorizedAccessException or System.Runtime.Serialization.SerializationException || failures.Classify(error).IsRejected;
				status = writeCompleted || dispatched && !rejected ? "unknown" : error is OperationCanceledException && token.IsCancellationRequested ? "cancelled" : "failed";
				var text = status == "unknown" ? "Azure may have accepted this write. Inspect current state before another import. Nothing was retried." : error is OperationException p ? p.Message : status == "cancelled" ? "Stopped at cancellation or the two-minute limit." : "The change failed. Check permissions, tier limits and current settings. Nothing was retried.";
				outcomes[index] = outcomes[index] with
				{
					Status = status,
					Summary = text
				};
				break;
			}
		}
		var count = outcomes.Count(s => s.Status == "confirmed");
		var result = new MessagingConfigResult(request.Id, gateway.Service, status, $"{count}/{outcomes.Length} configuration steps confirmed. " + (stopReason ?? (status == "completed" ? "Import completed." : "Stopped; earlier confirmed changes remain applied. Review every step before another import.")), outcomes);
		receipts.Add(request.Id, (fingerprint, result));
		return result;
	}
}
