using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Application.ServiceBus.Gateways;
using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Application.ServiceBus.Rules;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Messages;
using MsgCommander.Contracts.ServiceBus.Rules;
using System.Diagnostics;
using static MsgCommander.Application.ServiceBus.Entities.EntityManagement;

namespace MsgCommander.Application.ServiceBus.Administration;

/// <summary>Connection-owned entity plans and receipts. The caller serializes preview, execution and lookup.</summary>
public sealed class EntityBulkService(IServiceBusAdministrationGateway gateway, string namespaceName,
	Func<bool> hasReceiver, Action invalidateSnapshots, IAdministrationFailureClassifier failures)
{
	public void Clear()
	{
		bulkEntityPlans.Clear();
		bulkEntityRuns.Clear();
	}
	public BulkEntityResult? GetResult(string operationId) => bulkEntityRuns.TryGetValue(operationId, out var run) ? run.Result : null;
	private sealed record BulkEntitySnapshot(EntityConfiguration Configuration, IReadOnlyList<EntityConfiguration> Children);
	private sealed record PreparedBulkEntities(BulkEntityPlan Plan, IReadOnlyList<BulkEntitySnapshot> Snapshots, DateTimeOffset Expires);
	private readonly Dictionary<string, PreparedBulkEntities> bulkEntityPlans = [];
	private readonly Dictionary<string, (string Fingerprint, BulkEntityResult Result)> bulkEntityRuns = [];
	private static string BulkEntityKey(EntityTarget target) => $"{target.Kind}\0{target.TopicName}\0{target.Name}";
	private void RequireBulkEntityIdle()
	{
		if (hasReceiver())
			throw new OperationException(OperationFailure.OperationBlocked, "Close the message/session receiver before bulk entity actions.");
	}
	private async Task<BulkEntitySnapshot> CaptureBulkEntity(EntityTarget target, bool children, CancellationToken cancellation)
	{
		var config = await gateway!.GetEntityConfigurationAsync(target, cancellation);
		List<EntityConfiguration> subscriptions = [];
		if (children && target.Kind == "topic")
		{
			string? next = null;
			HashSet<string> tokens = [];
			HashSet<string> names = new(StringComparer.OrdinalIgnoreCase);
			var pages = 0;
			do
			{
				if (++pages > 100)
					throw new OperationException(OperationFailure.InspectionLimit, "Subscription review exceeded 100 pages. Select a smaller scope.");
				var page = await gateway.ListAsync("subscription", target.Name, next, cancellation);
				foreach (var child in page.Items)
				{
					if (child.Target.Kind != "subscription" || !string.Equals(child.Target.TopicName, target.Name, StringComparison.OrdinalIgnoreCase) || !names.Add(child.Target.Name))
						throw new OperationException(OperationFailure.InspectionLimit, "Subscription listing changed or returned an unexpected scope. Review again.");
					if (subscriptions.Count >= 499)
						throw new OperationException(OperationFailure.InspectionLimit, "Bulk actions support at most 500 affected entities, including subscriptions deleted with topics.");
					subscriptions.Add(await gateway.GetEntityConfigurationAsync(child.Target, cancellation));
				}
				next = page.ContinuationToken;
				if (next is not null && !tokens.Add(next))
					throw new OperationException(OperationFailure.InspectionLimit, "Subscription paging did not advance.");
			} while (next is not null);
		}
		return new(config, subscriptions.OrderBy(c => BulkEntityKey(c.Target), StringComparer.OrdinalIgnoreCase).ToArray());
	}
	private static bool SameBulkSnapshot(BulkEntitySnapshot a, BulkEntitySnapshot b) =>
		a.Configuration.Revision == b.Configuration.Revision && a.Children.Count == b.Children.Count &&
		a.Children.Zip(b.Children).All(pair => string.Equals(BulkEntityKey(pair.First.Target), BulkEntityKey(pair.Second.Target), StringComparison.OrdinalIgnoreCase) && pair.First.Revision == pair.Second.Revision);
	public async Task<BulkEntityPlan> PreviewAsync(BulkEntityPreviewRequest request, CancellationToken cancellation)
	{
		RequireBulkEntityIdle();
		var targets = request.Targets;
		var action = request.Action;
		var seconds = request.MaxSeconds;
		if (targets is null || targets.Count is < 1 or > 100 || seconds is < 1 or > 600 || action is null ||
			action.Kind is not ("delete" or "status") || action.Kind == "delete" && action.Status is not null ||
			action.Kind == "status" && action.Status is not ("Active" or "Disabled" or "SendDisabled" or "ReceiveDisabled"))
			throw new OperationException(OperationFailure.InvalidInput, "Choose 1–100 entities, a supported action and 1–600 seconds for the whole job.");
		HashSet<string> unique = new(StringComparer.OrdinalIgnoreCase);
		foreach (var target in targets)
		{
			if (target is null)
				throw new OperationException(OperationFailure.InvalidInput, "Missing entity.");
			ValidateTarget(target);
			if (target.Kind != "subscription" && target.TopicName is not null || !unique.Add(BulkEntityKey(target)))
				throw new OperationException(OperationFailure.InvalidInput, "Select each entity only once, with its correct parent.");
			if (action.Kind == "status" && (target.Kind == "topic" && action.Status == "ReceiveDisabled" || target.Kind == "subscription" && action.Status == "SendDisabled"))
				throw new OperationException(OperationFailure.InvalidInput, "This status is not supported by every selected entity.");
		}
		// A selected subscription of a deleted topic is covered by the topic's one broker operation.
		var roots = targets.Where(t => action.Kind != "delete" || t.Kind != "subscription" || !targets.Any(p => p.Kind == "topic" && Affects(p, t))).ToArray();
		List<BulkEntitySnapshot> snapshots = [];
		var affected = 0;
		foreach (var target in roots)
		{
			cancellation.ThrowIfCancellationRequested();
			BulkEntitySnapshot snapshot;
			try
			{
				snapshot = await CaptureBulkEntity(target, action.Kind == "delete", cancellation);
			}
			catch (OperationCanceledException) { throw; }
			catch (OperationException) { throw; }
			catch { throw new OperationException(OperationFailure.RevisionConflict, $"Could not review {target.Kind} {Path(target)}. Check that it exists and you have management access. No changes were made."); }
			affected += 1 + snapshot.Children.Count;
			if (affected > 500)
				throw new OperationException(OperationFailure.InvalidInput, "Select at most 500 affected entities including subscriptions deleted with topics.");
			snapshots.Add(snapshot);
		}
		cancellation.ThrowIfCancellationRequested();
		foreach (var old in bulkEntityPlans.Where(p => p.Value.Expires <= DateTimeOffset.UtcNow).Select(p => p.Key).ToArray())
			bulkEntityPlans.Remove(old);
		if (bulkEntityPlans.Count >= 5)
			bulkEntityPlans.Remove(bulkEntityPlans.Keys.First());
		if (bulkEntityRuns.Count >= 100)
			throw new OperationException(OperationFailure.OperationBlocked, "Bulk entity receipt limit reached. Review results before reconnecting.");
		var expires = DateTimeOffset.UtcNow.AddMinutes(10);
		var items = snapshots.Select(s => new BulkEntityPreviewItem(s.Configuration.Target, s.Configuration.Settings.Status, s.Children.Select(c => c.Target).ToArray())).ToArray();
		var phrase = $"{(action.Kind == "delete" ? "DELETE" : "SET " + action.Status)} {namespaceName} {affected} ENTITIES";
		var plan = new BulkEntityPlan(Guid.NewGuid().ToString(), namespaceName, action, items, affected, seconds, MsgCommander.Application.Common.DisplayValues.Timestamp(expires), phrase);
		bulkEntityPlans.Add(plan.PlanId, new(plan, snapshots.ToArray(), expires));
		return plan;
	}
	public async Task<BulkEntityResult> ExecuteAsync(BulkEntityExecution request, string fingerprint, Func<BulkEntityProgress, Task> emit, CancellationToken cancellation)
	{
		var id = request.Id;
		if (!Guid.TryParse(id, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid operation ID.");
		if (bulkEntityRuns.TryGetValue(id, out var previous))
		{
			if (fingerprint != previous.Fingerprint)
				throw new OperationException(OperationFailure.InvalidInput, "Bulk entity operation ID was already used for a different request.");
			return previous.Result;
		}
		if (bulkEntityRuns.Count >= 100)
			throw new OperationException(OperationFailure.OperationBlocked, "Bulk entity receipt limit reached. Review results before reconnecting.");
		var planId = request.PlanId;
		if (!bulkEntityPlans.TryGetValue(planId, out var prepared) || prepared.Expires <= DateTimeOffset.UtcNow)
			throw new OperationException(OperationFailure.InvalidInput, "This bulk entity review expired or was already used. Review again.");
		if (request.Confirmation != prepared.Plan.Confirmation)
			throw new OperationException(OperationFailure.InvalidInput, "Confirm the exact namespace, action and affected entity count.");
		RequireBulkEntityIdle();
		bulkEntityPlans.Remove(planId);
		var plan = prepared.Plan;
		var clock = Stopwatch.StartNew();
		using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
		deadline.CancelAfter(TimeSpan.FromSeconds(plan.MaxSeconds));
		var token = deadline.Token;
		var rows = plan.Items.Select(item => new BulkEntityRow(item.Target, "not-started", "Not started.")).ToArray();
		var status = "completed";
		var index = 0;
		var dispatched = false;
		var started = false;
		async Task Progress(int? active, string phase) => await emit(new(id, rows.ToArray(), active, phase,
			rows.Count(r => r.Status == "confirmed"), rows.Count(r => r.Status == "unknown"), clock.ElapsedMilliseconds));
		async Task Check(int i)
		{
			token.ThrowIfCancellationRequested();
			var fresh = await CaptureBulkEntity(rows[i].Target, plan.Action.Kind == "delete", token);
			if (!SameBulkSnapshot(prepared.Snapshots[i], fresh))
				throw new OperationException(OperationFailure.RevisionConflict, "Entity settings or the topic's subscription list changed since review. Review again.");
		}
		try
		{
			// Validate the entire review before any writes, then recheck each item at its turn.
			for (index = 0; index < rows.Length; index++)
			{
				started = true;
				await Progress(index, "checking");
				await Check(index);
			}
			for (index = 0; index < rows.Length; index++)
			{
				dispatched = false;
				started = false;
				token.ThrowIfCancellationRequested();
				started = true;
				await Progress(index, "applying");
				await Check(index);
				var config = prepared.Snapshots[index].Configuration;
				if (plan.Action.Kind == "status" && config.Settings.Status == plan.Action.Status)
					rows[index] = rows[index] with
					{
						Status = "unchanged",
						Summary = "Already has the requested status; no write sent."
					};
				else
				{
					await gateway!.ChangeEntityAsync(plan.Action.Kind == "delete" ? "delete" : "update", config.Target,
						plan.Action.Kind == "delete" ? null : config.Settings with
						{
							Status = plan.Action.Status!
						}, config.Revision,
						() => { dispatched = true; invalidateSnapshots(); }, token);
					var description = plan.Action.Kind != "delete"
						? $"Status {plan.Action.Status} acknowledged; other settings and rules preserved."
						: config.Target.Kind switch
						{
							"topic" => "Deletion acknowledged, including listed subscriptions and their rules/messages.",
							"subscription" => "Deletion acknowledged, including its rules and stored messages.",
							_ => "Deletion acknowledged, including stored messages."
						};
					rows[index] = rows[index] with
					{
						Status = "confirmed",
						Summary = description
					};
				}
				dispatched = false; // An acknowledged row remains confirmed even if progress transport fails.
				await Progress(null, "applying");
			}
		}
		catch (Exception error)
		{
			var rejected = error is OperationException or UnauthorizedAccessException or ArgumentException || failures.Classify(error).IsRejected;
			status = dispatched && !rejected ? "unknown" : token.IsCancellationRequested ? (cancellation.IsCancellationRequested ? "cancelled" : "limited") : "failed";
			if (started && index < rows.Length && rows[index].Status == "not-started")
				rows[index] = rows[index] with
				{
					Status = status == "unknown" ? "unknown" : status is "cancelled" or "limited" ? "cancelled" : "rejected",
					Summary = status == "unknown" ? "Acknowledgement missing. Inspect this entity before another attempt; the change may have succeeded." : error is OperationException known ? known.Message : status is "cancelled" or "limited" ? "Stopped before dispatch." : "Entity could not be verified or the broker rejected the change. Check its state and management permissions."
				};
		}
		var confirmed = rows.Count(r => r.Status == "confirmed");
		var uncertain = rows.Count(r => r.Status == "unknown");
		var summary = $"{confirmed} change{(confirmed == 1 ? "" : "s")} confirmed; {rows.Count(r => r.Status == "unchanged")} already in the requested state; {uncertain} uncertain; {rows.Count(r => r.Status == "not-started")} not started. " +
			(status == "completed" ? "All reviewed actions finished." : status == "limited" ? "Whole-job time limit reached. Completed changes cannot be undone." : status == "cancelled" ? "Cancelled. Completed changes cannot be undone." : "Stopped at the first failure or uncertain result; no automatic retry was made.");
		var result = new BulkEntityResult(id, plan, status, rows, confirmed, uncertain, clock.ElapsedMilliseconds, summary);
		bulkEntityRuns.Add(id, (fingerprint, result));
		try
		{
			await Progress(null, "finished");
		}
		catch
		{
			// Retained receipt remains available.
		}
		return result;
	}
}
