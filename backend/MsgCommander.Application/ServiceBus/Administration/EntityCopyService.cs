using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Application.ServiceBus.Gateways;
using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Application.ServiceBus.Rules;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Messages;
using MsgCommander.Contracts.ServiceBus.Rules;
using System.Security.Cryptography;
using System.Text.Json;
using static MsgCommander.Application.ServiceBus.Entities.EntityManagement;

namespace MsgCommander.Application.ServiceBus.Administration;

/// <summary>Connection-owned staged copies and source-removal receipts. Calls require owner serialization.</summary>
public sealed class EntityCopyService(IServiceBusAdministrationGateway gateway, string namespaceName,
	Func<EntityTarget?> receivedTarget, Action invalidateSnapshots, IAdministrationFailureClassifier failures)
{
	public void Clear()
	{
		copyPlans.Clear();
		copyRuns.Clear();
		removalReviews.Clear();
		removalReceipts.Clear();
	}
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	public EntityCopyResult? GetResult(string operationId) => copyRuns.TryGetValue(operationId, out var run) ? run.Result : null;
	public OperationOutcome? GetRemovalResult(string operationId) => removalReceipts.TryGetValue(operationId, out var receipt) ? receipt.Outcome : null;
	private sealed record CopySnapshot(EntityCopyState State, IReadOnlyList<RuleConfiguration> Rules);
	private sealed record CopyPlan(EntityCopyPreview Preview, IReadOnlyList<CopySnapshot> Source, string Stamp, DateTimeOffset Expires);
	private sealed class CopyRun(CopyPlan plan, string fingerprint, EntityCopyResult result)
	{
		public CopyPlan Plan = plan;
		public string Fingerprint = fingerprint;
		public EntityCopyResult Result = result;
		public IReadOnlyList<CopySnapshot>? Destination;
		public bool RemovalAttempted;
	}
	private sealed record RemovalReview(RenameReview Value, string SourceStamp, DateTimeOffset Expires);
	private readonly Dictionary<string, CopyPlan> copyPlans = [];
	private readonly Dictionary<string, CopyRun> copyRuns = [];
	private readonly Dictionary<string, RemovalReview> removalReviews = [];
	private readonly Dictionary<string, (string Fingerprint, OperationOutcome Outcome)> removalReceipts = [];
	private static string CopyStamp(object value) => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, Json)));
	private static string CopyPath(EntityTarget target) => target.Kind + ":" + Path(target).ToLowerInvariant();
	private static EntityTarget DestinationFor(EntityCopySpec spec, EntityTarget source) => source == spec.Source ? spec.Destination : new("subscription", source.Name, spec.Destination.Name);
	private string CopyPhrase(EntityCopySpec spec) => $"{(spec.Mode == "rename" ? "PREPARE RENAME" : "DUPLICATE")} {namespaceName}/{spec.Source.Kind}/{Path(spec.Source)} -> {Path(spec.Destination)}";
	private string RemovalPhrase(EntityCopySpec spec) => $"DELETE RENAMED SOURCE {namespaceName}/{spec.Source.Kind}/{Path(spec.Source)} -> {Path(spec.Destination)}";
	private static void ValidateCopy(EntityCopySpec spec)
	{
		ValidateTarget(spec.Source);
		ValidateTarget(spec.Destination);
		if (spec.Source.Kind != "subscription" && (spec.Source.TopicName is not null || spec.Destination.TopicName is not null))
			throw new OperationException(OperationFailure.InvalidInput, "Only subscriptions have parent topics.");
		if (spec.Mode is not ("duplicate" or "rename") || spec.Source.Kind != spec.Destination.Kind || CopyPath(spec.Source) == CopyPath(spec.Destination) ||
			spec.Source.Kind != "topic" && spec.IncludeSubscriptions ||
			spec.Mode == "rename" && (spec.Source.Kind == "topic" && !spec.IncludeSubscriptions || spec.Source.Kind == "subscription" && !string.Equals(spec.Source.TopicName, spec.Destination.TopicName, StringComparison.OrdinalIgnoreCase)))
			throw new OperationException(OperationFailure.InvalidInput, "Choose a different destination of the same kind. Topic renames include all subscriptions; subscription renames stay in their current topic.");
	}
	private async Task<IReadOnlyList<CopySnapshot>> ReadCopyTree(EntityTarget root, bool children, CancellationToken cancellation)
	{
		List<EntityTarget> targets = [root];
		if (root.Kind == "topic" && children)
		{
			string? next = null;
			HashSet<string> seen = [];
			do
			{
				var page = await gateway!.ListAsync("subscription", root.Name, next, cancellation);
				foreach (var item in page.Items)
				{
					if (item.Target.Kind != "subscription" || !string.Equals(item.Target.TopicName, root.Name, StringComparison.OrdinalIgnoreCase))
						throw new OperationException(OperationFailure.InspectionLimit, "Subscription listing returned an unexpected scope.");
					if (targets.Count >= 50)
						throw new OperationException(OperationFailure.InspectionLimit, "Copy supports at most 50 entities including the topic.");
					if (targets.Any(t => CopyPath(t) == CopyPath(item.Target)))
						throw new OperationException(OperationFailure.InspectionLimit, "Subscription listing changed while preparing the copy. Refresh it.");
					targets.Add(item.Target);
				}
				next = page.ContinuationToken;
				if (next is not null && !seen.Add(next))
					throw new OperationException(OperationFailure.InspectionLimit, "Subscription paging did not advance.");
			} while (next is not null);
		}
		List<CopySnapshot> snapshots = [];
		var totalRules = 0;
		foreach (var target in targets.OrderBy(CopyPath, StringComparer.Ordinal))
		{
			var state = await gateway!.GetEntityCopyStateAsync(target, cancellation);
			List<RuleConfiguration> rules = [];
			if (target.Kind == "subscription")
			{
				string? next = null;
				HashSet<string> pages = [];
				HashSet<string> names = new(StringComparer.OrdinalIgnoreCase);
				do
				{
					var page = await gateway.ListRulesAsync(target, next, cancellation);
					foreach (var item in page.Items)
					{
						if (++totalRules > 200)
							throw new OperationException(OperationFailure.InspectionLimit, "Copy supports at most 200 subscription rules in one job.");
						if (!names.Add(item.Name))
							throw new OperationException(OperationFailure.InspectionLimit, "Rule listing changed while preparing the copy. Refresh it.");
						var rule = await gateway.GetRuleAsync(target, item.Name, cancellation);
						if (rule.ReadOnlyReason is not null)
							throw new OperationException(OperationFailure.UnsupportedOperation, "A subscription rule contains unsupported fields or types. No copy can be made without losing them.");
						SubscriptionRules.Validate(rule.Definition);
						rules.Add(rule);
					}
					next = page.ContinuationToken;
					if (next is not null && !pages.Add(next))
						throw new OperationException(OperationFailure.InspectionLimit, "Rule paging did not advance.");
				} while (next is not null);
			}
			snapshots.Add(new(state, rules.OrderBy(r => r.Name, StringComparer.Ordinal).ToArray()));
			if (JsonSerializer.SerializeToUtf8Bytes(snapshots, Json).Length > 4 * 1024 * 1024)
				throw new OperationException(OperationFailure.InspectionLimit, "Copy configuration exceeds the 4 MiB local snapshot limit.");
		}
		return snapshots;
	}
	private async Task RequireNewDestination(EntityCopySpec spec, CancellationToken cancellation)
	{
		if (await gateway!.EntityExistsAsync(spec.Destination, cancellation))
			throw new OperationException(OperationFailure.RevisionConflict, "Destination already exists. Copy never overwrites or merges with an existing entity.");
		if (spec.Destination.Kind == "subscription" && !await gateway.EntityExistsAsync(new("topic", spec.Destination.TopicName!), cancellation))
			throw new OperationException(OperationFailure.RevisionConflict, "Destination topic does not exist.");
	}
	private static object Comparable(IReadOnlyList<CopySnapshot> snapshots, bool ignoreStatus = false) => snapshots.Select(s => new
	{
		path = CopyPath(s.State.Configuration.Target),
		identity = s.State.Identity,
		settings = ignoreStatus ? s.State.Configuration.Settings with
		{
			Status = "Active"
		} : s.State.Configuration.Settings,
		rules = s.Rules.Select(r => new { r.Name, r.Definition }).ToArray()
	}).ToArray();
	public async Task<EntityCopyPreview> PreviewAsync(EntityCopySpec spec, CancellationToken cancellation)
	{
		ValidateCopy(spec);
		foreach (var old in copyPlans.Where(p => p.Value.Expires < DateTimeOffset.UtcNow).Select(p => p.Key).ToArray())
			copyPlans.Remove(old);
		if (copyPlans.Count >= 5)
			copyPlans.Remove(copyPlans.Keys.First());
		if (copyRuns.Count >= 20)
			throw new OperationException(OperationFailure.InspectionLimit, "Local copy plan/receipt limit reached. Reconnect after reviewing existing jobs.");
		await RequireNewDestination(spec, cancellation);
		var source = await ReadCopyTree(spec.Source, spec.IncludeSubscriptions, cancellation);
		var items = source.Select(s => new EntityCopyItem(s.State.Configuration.Target, DestinationFor(spec, s.State.Configuration.Target), s.State.Configuration.Settings,
			s.Rules.Select(r => new RuleSummary(r.Name, r.Definition.FilterType, r.Definition.ActionExpression.Length > 0)).ToArray())).ToArray();
		foreach (var item in items)
			Validate(item.Destination, item.Settings);
		var expires = DateTimeOffset.UtcNow.AddMinutes(15);
		var preview = new EntityCopyPreview(Guid.NewGuid().ToString(), spec, items, items.Sum(i => 2 + i.Rules.Count + (i.Source.Kind == "subscription" ? 1 : 0)) + 1, MsgCommander.Application.Common.DisplayValues.Timestamp(expires));
		copyPlans.Add(preview.PlanId, new(preview, source, CopyStamp(source), expires));
		return preview;
	}
	private async Task VerifyDestination(CopyRun run, CancellationToken cancellation)
	{
		var spec = run.Plan.Preview.Spec;
		var actual = await ReadCopyTree(spec.Destination, spec.IncludeSubscriptions, cancellation);
		if (actual.Count != run.Plan.Source.Count)
			throw new OperationException(OperationFailure.RevisionConflict, "Destination entity inventory differs from the copy plan.");
		foreach (var source in run.Plan.Source)
		{
			var target = DestinationFor(spec, source.State.Configuration.Target);
			var item = actual.SingleOrDefault(s => CopyPath(s.State.Configuration.Target) == CopyPath(target));
			if (item is null || item.State.Configuration.Settings != source.State.Configuration.Settings || CopyStamp(item.Rules.Select(r => new { r.Name, r.Definition })) != CopyStamp(source.Rules.Select(r => new { r.Name, r.Definition })))
				throw new OperationException(OperationFailure.RevisionConflict, "Destination settings or rules differ from the copy plan. Inspect both entities; the source was retained.");
		}
		run.Destination = actual;
	}
	public async Task<EntityCopyResult> ExecuteAsync(EntityCopyExecution request, string fingerprint, Func<EntityCopyProgress, Task> emit, CancellationToken cancellation)
	{
		var id = request.Id;
		if (copyRuns.TryGetValue(id, out var prior))
		{
			if (prior.Fingerprint != fingerprint)
				throw new OperationException(OperationFailure.InvalidInput, "Operation ID already used for a different copy request.");
			return prior.Result;
		}
		if (copyRuns.Count >= 20)
			throw new OperationException(OperationFailure.InspectionLimit, "Copy receipt limit reached. Review jobs before reconnecting.");
		var planId = request.PlanId;
		if (!copyPlans.TryGetValue(planId, out var plan) || plan.Expires < DateTimeOffset.UtcNow)
			throw new OperationException(OperationFailure.RevisionConflict, "Copy preview expired or was already used. Prepare a new preview.");
		if (request.Confirmation != CopyPhrase(plan.Preview.Spec))
			throw new OperationException(OperationFailure.InvalidInput, "Type the exact copy action and source/destination paths.");
		copyPlans.Remove(planId);
		var spec = plan.Preview.Spec;
		List<EntityCopyStep> steps = [];
		var run = new CopyRun(plan, fingerprint, new(id, planId, spec, "running", steps, "Preparing the configuration copy. Source retained.", false));
		copyRuns.Add(id, run);
		var dispatched = false;
		var writes = 0;
		async Task Step(string action, EntityTarget target, string? ruleName, Func<Action, Task> work, bool write = true)
		{
			cancellation.ThrowIfCancellationRequested();
			dispatched = false;
			steps.Add(new(steps.Count + 1, action, target, ruleName, "running"));
			await emit(new(id, 100.0 * (steps.Count - 1) / plan.Preview.StepCount, $"{action}: {Path(target)}{(ruleName is null ? "" : "/Rules/" + ruleName)}"));
			await work(() => dispatched = true);
			if (write)
				writes++;
			steps[^1] = steps[^1] with
			{
				Status = "confirmed"
			};
			dispatched = false;
		}
		try
		{
			await RequireNewDestination(spec, cancellation);
			if (CopyStamp(await ReadCopyTree(spec.Source, spec.IncludeSubscriptions, cancellation)) != plan.Stamp)
				throw new OperationException(OperationFailure.RevisionConflict, "Source settings, subscriptions or rules changed. Prepare a new preview.");
			var guard = "$CommanderCopy_" + Guid.NewGuid().ToString("N");
			if (plan.Source.Any(s => s.Rules.Any(r => r.Name.Equals(guard, StringComparison.OrdinalIgnoreCase))))
				throw new OperationException(OperationFailure.RevisionConflict, "Copy guard name collision. Prepare a new preview.");
			// Root first, then subscriptions. Every destination starts disabled; subscriptions start with a false rule.
			foreach (var item in plan.Preview.Entities.OrderBy(i => i.Source == spec.Source ? 0 : 1))
			{
				await Step("Create disabled entity", item.Destination, null, dispatch => gateway!.CreateEntityCopyAsync(item.Destination, item.Settings with { Status = "Disabled" }, guard, dispatch, cancellation));
				var source = plan.Source.Single(s => s.State.Configuration.Target == item.Source);
				foreach (var rule in source.Rules)
					await Step("Copy rule", item.Destination, rule.Name, dispatch => gateway!.ChangeRuleAsync("create", item.Destination, rule.Name, rule.Definition, null, dispatch, cancellation));
				if (item.Source.Kind == "subscription")
					await Step("Remove false guard", item.Destination, guard, async dispatch =>
					{
						var existing = await gateway!.GetRuleAsync(item.Destination, guard, cancellation);
						await gateway.ChangeRuleAsync("delete", item.Destination, guard, null, existing.Revision, dispatch, cancellation);
					});
			}
			// Restore the topic's status last, after all its subscriptions/rules have been copied.
			foreach (var item in plan.Preview.Entities.OrderBy(i => i.Source.Kind == "topic" ? 1 : 0))
				await Step("Restore copied status", item.Destination, null, async dispatch =>
				{
					var current = await gateway!.GetEntityConfigurationAsync(item.Destination, cancellation);
					if (current.Settings != item.Settings with
					{
						Status = "Disabled"
					})
						throw new OperationException(OperationFailure.RevisionConflict, "Destination settings changed during the copy. Source retained.");
					await gateway.ChangeEntityAsync("update", item.Destination, item.Settings, current.Revision, dispatch, cancellation);
				});
			await Step("Verify destination", spec.Destination, null, _ => VerifyDestination(run, cancellation), write: false);
			run.Result = run.Result with
			{
				Status = "confirmed",
				CanFinishRename = spec.Mode == "rename",
				Summary = spec.Mode == "rename" ? "Configuration copy verified. The source remains. Switch clients and stop source traffic before reviewing source removal." : "Configuration copy verified. Source and messages were retained; SAS policies and session state were not copied."
			};
		}
		catch (Exception error)
		{
			var unknown = dispatched && !failures.Classify(error).IsRejected;
			var status = unknown ? "unknown" : writes > 0 ? "partial" : error is OperationCanceledException ? "cancelled" : "rejected";
			if (steps.Count > 0 && steps[^1].Status == "running")
				steps[^1] = steps[^1] with
				{
					Status = unknown ? "unknown" : error is OperationCanceledException ? "cancelled" : "rejected"
				};
			var detail = error is OperationException known ? known.Message : failures.Classify(error).IsPermissionDenied ? "Administration permission was denied." : "The job stopped before all steps were verified.";
			run.Result = run.Result with
			{
				Status = status,
				Summary = $"{detail} Source retained. Inspect the destination and this receipt before any new attempt; no retry or rollback was performed."
			};
		}
		await emit(new(id, run.Result.Status == "confirmed" ? 100.0 : 100.0 * steps.Count(s => s.Status == "confirmed") / plan.Preview.StepCount, run.Result.Summary));
		return run.Result;
	}
	private CopyRun CompletedRename(string operationId)
	{
		if (!copyRuns.TryGetValue(operationId, out var run) || run.Result.Status != "confirmed" || run.Result.Spec.Mode != "rename" || run.Destination is null || run.RemovalAttempted)
			throw new OperationException(OperationFailure.RevisionConflict, "No verified staged rename is available for source removal in this connection.");
		return run;
	}
	public async Task<RenameReview> ReviewRenameAsync(string operationId, CancellationToken cancellation)
	{
		var run = CompletedRename(operationId);
		var spec = run.Result.Spec;
		var source = await ReadCopyTree(spec.Source, spec.IncludeSubscriptions, cancellation);
		var destination = await ReadCopyTree(spec.Destination, spec.IncludeSubscriptions, cancellation);
		List<string> blockers = [];
		if (CopyStamp(Comparable(source, true)) != CopyStamp(Comparable(run.Plan.Source, true)))
			blockers.Add("Source settings, subscription inventory or rules changed since the copy. Only a source status change is allowed for cutover.");
		if (CopyStamp(Comparable(destination, true)) != CopyStamp(Comparable(run.Destination!, true)))
			blockers.Add("Destination configuration changed or was replaced since verification.");
		if (source.Single(s => CopyPath(s.State.Configuration.Target) == CopyPath(spec.Source)).State.Configuration.Settings.Status != "Disabled")
			blockers.Add("Disable the source entity after draining messages and stopping its clients.");
		if (Affects(spec.Source, receivedTarget()))
			blockers.Add("Close the owned source message/session receiver before removing the source.");
		List<RenameSourceEntry> entries = [];
		foreach (var item in source)
		{
			var target = item.State.Configuration.Target;
			var detail = await gateway!.GetEntityAsync(target, cancellation);
			var c = detail.Counts;
			var counts = target.Kind == "topic" ? new[] { c.Scheduled } : target.Kind == "queue" ? new[] { c.Total, c.Active, c.DeadLetter, c.Scheduled, c.Transfer, c.TransferDeadLetter } : [c.Total, c.Active, c.DeadLetter, c.Transfer, c.TransferDeadLetter];
			if (counts.Any(value => !long.TryParse(value, out var n) || n != 0))
				blockers.Add($"{Path(target)} has messages or unavailable counts. Drain active, dead-letter, scheduled and transfer messages before removal.");
			entries.Add(new(target, item.State.Configuration.Settings.Status, c));
		}
		var expires = DateTimeOffset.UtcNow.AddMinutes(5);
		var review = new RenameReview(Guid.NewGuid().ToString(), operationId, spec.Source, spec.Destination, entries, blockers, MsgCommander.Application.Common.DisplayValues.Timestamp(expires));
		foreach (var old in removalReviews.Where(p => p.Value.Value.CopyOperationId == operationId || p.Value.Expires < DateTimeOffset.UtcNow).Select(p => p.Key).ToArray())
			removalReviews.Remove(old);
		removalReviews[review.ReviewId] = new(review, CopyStamp(source), expires);
		return review;
	}
	public async Task<OperationOutcome> FinishRenameAsync(RenameSourceRemoval request, string fingerprint, CancellationToken cancellation)
	{
		var id = request.Id;
		if (removalReceipts.TryGetValue(id, out var prior))
		{
			if (prior.Fingerprint != fingerprint)
				throw new OperationException(OperationFailure.InvalidInput, "Operation ID already used for another source removal.");
			return prior.Outcome;
		}
		if (removalReceipts.Count >= 1000)
			throw new OperationException(OperationFailure.InspectionLimit, "Source-removal receipt limit reached. Reconnect after reviewing jobs.");
		var reviewId = request.ReviewId;
		if (!removalReviews.TryGetValue(reviewId, out var saved) || saved.Expires < DateTimeOffset.UtcNow || saved.Value.Blockers.Count > 0)
			throw new OperationException(OperationFailure.RevisionConflict, "Review source removal again and resolve every blocker.");
		var run = CompletedRename(saved.Value.CopyOperationId);
		var spec = run.Result.Spec;
		if (request.Confirmation != RemovalPhrase(spec))
			throw new OperationException(OperationFailure.InvalidInput, "Type the exact source-removal confirmation.");
		var dispatched = false;
		OperationOutcome outcome;
		try
		{
			var fresh = await ReviewRenameAsync(saved.Value.CopyOperationId, cancellation);
			if (fresh.Blockers.Count > 0 || removalReviews[fresh.ReviewId].SourceStamp != saved.SourceStamp)
				throw new OperationException(OperationFailure.RevisionConflict, "Source-removal preflight changed or found messages. Review again; nothing was deleted.");
			var current = await gateway!.GetEntityConfigurationAsync(spec.Source, cancellation);
			if (current.Settings != run.Plan.Source.Single(s => CopyPath(s.State.Configuration.Target) == CopyPath(spec.Source)).State.Configuration.Settings with
			{
				Status = "Disabled"
			})
				throw new OperationException(OperationFailure.RevisionConflict, "Source settings changed before deletion. Review again.");
			cancellation.ThrowIfCancellationRequested();
			await gateway.ChangeEntityAsync("delete", spec.Source, null, current.Revision, () => { dispatched = true; run.RemovalAttempted = true; }, cancellation);
			invalidateSnapshots();
			outcome = new(id, "confirmed", "Azure acknowledged deletion of the old source. The verified destination remains. Client references and forwarding were not rewritten.", null);
		}
		catch (Exception error)
		{
			var rejected = failures.Classify(error).IsRejected;
			var status = dispatched && !rejected ? "unknown" : error is OperationCanceledException ? "cancelled" : "rejected";
			if (status != "unknown")
				run.RemovalAttempted = false;
			outcome = new(id, status, error is OperationException known ? known.Message : status == "unknown" ? "Source deletion outcome is unknown. Inspect Azure and this receipt. Nothing was retried; the destination was retained." : "Source removal was not confirmed. Review entity state, permissions and message counts again.", null);
		}
		run.Result = run.Result with
		{
			CanFinishRename = !run.RemovalAttempted,
			Summary = outcome.Status == "confirmed" ? "Configuration copy verified; old source deletion confirmed. Destination retained." : outcome.Status == "unknown" ? "Configuration copy verified; source deletion outcome is unknown. Inspect the source-removal receipt and Azure." : run.Result.Summary
		};
		removalReceipts.Add(id, (fingerprint, outcome));
		return outcome;
	}
}
