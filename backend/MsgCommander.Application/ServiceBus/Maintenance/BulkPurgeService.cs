using System.Diagnostics;
using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Application.ServiceBus.Gateways;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Maintenance;
using static MsgCommander.Application.ServiceBus.Maintenance.MaintenancePolicies;

namespace MsgCommander.Application.ServiceBus.Maintenance;

public sealed class BulkPurgeService(IEntityReader gateway, PurgeService purge, string namespaceName, Func<bool> hasInteractiveReceiver)
{
	public BulkPurgeResult? GetResult(string id) => bulkPurges.Get(id);
	public BulkPurgeResult? CheckRequest(string id, string fingerprint) => bulkPurges.CheckRequest(id, fingerprint);
	public void Clear()
	{
		bulkPurgePlans.Clear();
		bulkPurges.Clear();
	}
	private readonly Dictionary<string, (BulkPurgePlan Plan, DateTimeOffset Expires)> bulkPurgePlans = [];
	private readonly OperationReceipts<BulkPurgeResult> bulkPurges = new(100, "Bulk purge operation ID was already used for a different request.", "Bulk purge receipt limit reached. Review results before reconnecting.");

	private void RequirePurgeIdle()
	{
		if (hasInteractiveReceiver())
			throw new OperationException(OperationFailure.OperationBlocked, "Close the current message or session receiver before starting a bulk purge.");
	}
	public async Task<BulkPurgePlan> PreviewAsync(PreviewBulkPurge request, CancellationToken cancellation)
	{
		RequirePurgeIdle();
		var targets = request.Targets?.ToArray();
		var perTarget = request.MaxPerTarget;
		var total = request.MaxTotal;
		var seconds = request.MaxSeconds;
		var cutoff = ParseCutoff(request.Cutoff);
		if (targets is null || targets.Length is < 1 or > 100 || perTarget is < 1 or > 100000 || total is < 1 or > 100000 || seconds is < 1 or > 600)
			throw new OperationException(OperationFailure.InvalidInput, "Select 1–100 subqueues, 1–100000 deletions per target/overall and 1–600 seconds for the whole job.");
		HashSet<string> unique = new(StringComparer.OrdinalIgnoreCase);
		// Validate the entire list before any broker request, and keep this order in the review.
		foreach (var item in targets)
		{
			if (item?.Target is null)
				throw new OperationException(OperationFailure.InvalidInput, "Missing purge target.");
			item.Target.Validate(peek: true);
			if (item.Target.Kind == "queue" && item.Target.TopicName is not null)
				throw new OperationException(OperationFailure.InvalidInput, "Queues cannot have a parent topic.");
			ValidateSubQueue(item.SubQueue);
			if (!unique.Add($"{item.Target.Kind}\0{item.Target.TopicName}\0{item.Target.Name}\0{item.SubQueue}"))
				throw new OperationException(OperationFailure.InvalidInput, "Select each entity/subqueue only once.");
		}
		List<BulkPurgePreviewItem> items = [];
		foreach (var item in targets)
		{
			cancellation.ThrowIfCancellationRequested();
			EntityDetails entity;
			try
			{
				entity = await gateway!.GetEntityAsync(item.Target, cancellation);
			}
			catch (OperationCanceledException) { throw; }
			catch { throw new OperationException(OperationFailure.RevisionConflict, $"Could not review {item.Target.Kind} {EntityManagement.Path(item.Target)} / {item.SubQueue}. Check that it exists and you have management access. No bulk purge was started."); }
			var count = item.SubQueue switch
			{
				"active" => entity.Counts.Active,
				"dead-letter" => entity.Counts.DeadLetter,
				_ => entity.Counts.TransferDeadLetter
			};
			items.Add(new(item.Target, item.SubQueue, entity.CountsWarning is null ? count : null));
		}
		cancellation.ThrowIfCancellationRequested();
		foreach (var old in bulkPurgePlans.Where(p => p.Value.Expires <= DateTimeOffset.UtcNow).Select(p => p.Key).ToArray())
			bulkPurgePlans.Remove(old);
		if (bulkPurgePlans.Count >= 5)
			bulkPurgePlans.Remove(bulkPurgePlans.Keys.First());
		if (bulkPurges.Results.Count() >= 100)
			throw new OperationException(OperationFailure.OperationBlocked, "Bulk purge receipt limit reached. Review results before reconnecting.");
		var expires = DateTimeOffset.UtcNow.AddMinutes(10);
		var plan = new BulkPurgePlan(Guid.NewGuid().ToString(), namespaceName, Array.AsReadOnly(items.ToArray()), perTarget, total, seconds,
			MsgCommander.Application.Common.DisplayValues.Timestamp(expires), $"PURGE {namespaceName} {items.Count} TARGETS" + (cutoff is null ? "" : $" BEFORE {CutoffText(cutoff)}"), CutoffText(cutoff));
		bulkPurgePlans.Add(plan.PlanId, (plan, expires));
		return plan;
	}

	public async Task<BulkPurgeResult> ExecuteAsync(ExecuteBulkPurge request, string fingerprint, Func<BulkPurgeProgress, Task> emit, CancellationToken cancellation)
	{
		var id = request.Id;
		if (CheckRequest(id, fingerprint) is { } previous)
			return previous;
		var planId = request.PlanId;
		if (!bulkPurgePlans.TryGetValue(planId, out var prepared) || prepared.Expires <= DateTimeOffset.UtcNow)
			throw new OperationException(OperationFailure.InvalidInput, "This bulk purge review expired or was already used. Review the selection again.");
		var plan = prepared.Plan;
		// Execution must use the reviewed cutoff. Reject attempts to override it even at the host boundary.
		if (request.ContainsCutoffOverride)
			throw new OperationException(OperationFailure.InvalidInput, "Review the cutoff again before changing it.");
		if (request.Confirmation != plan.Confirmation)
			throw new OperationException(OperationFailure.InvalidInput, "Confirm the exact namespace and reviewed target count.");
		RequirePurgeIdle();
		bulkPurgePlans.Remove(planId); // One execution per immutable review, including partial/cancelled jobs.
		var clock = Stopwatch.StartNew();
		var rows = plan.Items.Select(item => new BulkPurgeItem(item.Target, item.SubQueue, null)).ToArray();
		var received = 0;
		var completed = 0;
		var uncertain = 0;
		var skipped = 0;
		var cutoff = plan.BeforeEnqueueTime is null ? (DateTimeOffset?)null : DateTimeOffset.Parse(plan.BeforeEnqueueTime, System.Globalization.CultureInfo.InvariantCulture);
		var status = "completed";
		var reason = "targets-finished";
		async Task Progress(int? index, PurgeProgress? current, string phase = "running") => await emit(new(
			id, index, current, Array.AsReadOnly(rows.ToArray()), received + (current?.Received ?? 0), completed + (current?.Completed ?? 0),
			uncertain + (current?.Uncertain ?? 0), clock.ElapsedMilliseconds, phase, skipped + (current?.Skipped ?? 0)));
		for (var index = 0; index < rows.Length; index++)
		{
			if (cancellation.IsCancellationRequested)
			{
				status = "cancelled";
				reason = "cancelled";
				break;
			}
			var remaining = TimeSpan.FromSeconds(plan.MaxSeconds) - clock.Elapsed;
			if (remaining <= TimeSpan.Zero)
			{
				status = "limited";
				reason = "time-limit";
				break;
			}
			if (completed >= plan.MaxTotal)
			{
				status = "limited";
				reason = "total-limit";
				break;
			}
			var row = rows[index];
			var result = await purge.RunAsync(id, row.Target, row.SubQueue, Math.Min(plan.MaxPerTarget, plan.MaxTotal - completed), remaining, cutoff,
				current => Progress(index, current), cancellation);
			rows[index] = row with
			{
				Result = result
			};
			received += result.Received;
			completed += result.Completed;
			uncertain += result.Uncertain;
			skipped += result.Skipped;
			// Even progress transport failure cannot discard an acknowledged per-target receipt.
			try
			{
				await Progress(null, null);
			}
			catch { status = "failed"; reason = "target-error"; }
			if (result.Status is "failed" or "unknown" or "cancelled")
			{
				status = result.Status;
				reason = result.Status == "cancelled" ? "cancelled" : "target-error";
				break;
			}
			if (result.CleanupWarning is not null)
			{
				status = "failed";
				reason = "cleanup-error";
				break;
			}
			if (reason == "target-error")
				break;
			if (result.Reason == "time-limit")
			{
				status = "limited";
				reason = "time-limit";
				break;
			}
			if (completed >= plan.MaxTotal)
			{
				status = "limited";
				reason = "total-limit";
				break;
			}
			if (result.Status == "limited")
			{
				status = "limited";
				reason = "target-limits";
			}
		}
		var attempted = rows.Count(row => row.Result is not null);
		var stop = reason switch
		{
			"targets-finished" => "All selected targets visited. An empty receive does not prove an empty queue.",
			"target-limits" => "All selected targets visited; one or more reached their per-target limit (deletions or cutoff scan).",
			"total-limit" => "Overall deletion limit reached.",
			"time-limit" => "Whole-job time limit reached.",
			"cancelled" => "Cancelled. Confirmed deletions cannot be undone.",
			"cleanup-error" => "Receiver cleanup could not be confirmed; remaining targets were not started.",
			_ => "Stopped at a failed or uncertain target; no automatic retry was made."
		};
		var summary = $"{completed} deletions confirmed; {uncertain} uncertain; {attempted}/{rows.Length} targets attempted. {stop}";
		if (cutoff is not null)
			summary += $" {skipped} messages at or after {plan.BeforeEnqueueTime} left unsettled.";
		var receipt = new BulkPurgeResult(id, plan, status, reason, Array.AsReadOnly(rows), received, completed, uncertain, clock.ElapsedMilliseconds, summary, skipped);
		bulkPurges.Add(id, fingerprint, receipt);
		try
		{
			await Progress(null, null, "finished");
		}
		catch
		{
			// The retained receipt is authoritative.
		}
		return receipt;
	}
}
