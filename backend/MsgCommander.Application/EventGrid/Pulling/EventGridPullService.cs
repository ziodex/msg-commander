using System.Diagnostics;
using System.Text;
using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.EventGrid.Gateways;
using MsgCommander.Application.EventGrid.Browsing;
using MsgCommander.Contracts.EventGrid.Browsing;
using MsgCommander.Contracts.EventGrid.Pulling;

namespace MsgCommander.Application.EventGrid.Pulling;

public sealed class EventGridPullService(IEventGridGateway gateway, IEventGridFailureClassifier failures, TimeProvider? timeProvider = null)
{
	private DateTimeOffset PullNow => (timeProvider ?? TimeProvider.System).GetUtcNow();
	private sealed class HeldEvent(EventGridReceived item, EventGridLockToken token, string json, int duration, DateTimeOffset first)
	{
		public EventGridReceived Item = item; public EventGridLockToken? Token = token; public readonly string Json = json; public readonly int Duration = duration; public readonly DateTimeOffset First = first;
	}
	private readonly Dictionary<string, HeldEvent> held = [];
	private readonly Dictionary<string, (string Stamp, EventGridPullOutcome Result)> pulls = [];
	private static OperationException PullBad() => new(OperationFailure.InvalidInput, "Choose a queue subscription, bounded receive settings or unique event handles, and confirm the operation.");
	private static void PullTarget(EventGridTarget target)
	{
		target.Validate();
		if (target.Kind != "subscription")
			throw PullBad();
	}
	private HeldEvent FindHeld(EventGridTarget target, string handle)
	{
		if (!held.TryGetValue(handle, out var value) || value.Item.Target != target)
			throw new OperationException(OperationFailure.InvalidInput, "Event handle expired or belongs to another subscription. Refresh received events.");
		Expire(value);
		return value;
	}
	private void Expire(HeldEvent value)
	{
		if (value.Item.State == "held" && PullNow >= DateTimeOffset.Parse(value.Item.EstimatedLockedUntil))
		{
			value.Item = value.Item with
			{
				State = "expired"
			};
			value.Token = null;
		}
	}
	public EventGridPullOutcome? GetResult(string id)
	{
		if (!Guid.TryParse(id, out _))
			throw PullBad();
		return pulls.TryGetValue(id, out var saved) ? saved.Result : null;
	}
	public EventGridEventInspection Inspect(EventGridTarget target, string handle)
	{
		PullTarget(target);
		var value = FindHeld(target, handle);
		var text = value.Json;
		var length = Math.Min(text.Length, 65536);
		if (length > 0 && char.IsHighSurrogate(text[length - 1]))
			length--;
		return new(value.Item, text[..length], length < text.Length);
	}
	public EventGridReceived[] List(EventGridTarget target, bool clear = false)
	{
		PullTarget(target);
		foreach (var value in held.Values)
			Expire(value);
		if (clear)
			foreach (var key in held.Where(p => p.Value.Item.Target == target && p.Value.Item.State != "held").Select(p => p.Key).ToArray())
				held.Remove(key);
		return held.Values.Where(v => v.Item.Target == target).Select(v => v.Item).ToArray();
	}
	public void Clear()
	{
		held.Clear();
		pulls.Clear();
	}
	private bool SavedPull(string id, string stamp, out EventGridPullOutcome? result)
	{
		result = null;
		if (pulls.TryGetValue(id, out var saved))
		{
			if (saved.Stamp != stamp)
				throw new OperationException(OperationFailure.InvalidInput, "This pull receipt ID belongs to different inputs. Review it before a new operation.");
			result = saved.Result;
			return true;
		}
		if (pulls.Count >= 100)
			throw new OperationException(OperationFailure.OperationBlocked, "Pull receipt limit reached. Reconnect after settling or allowing held events to expire.");
		return false;
	}
	private bool Rejected(Exception e) => failures.Classify(e, EventGridFailureOperation.Pull).Rejected;
	private string PullFailure(Exception e) => failures.Classify(e, EventGridFailureOperation.Pull).Denied ? "Event Grid data access was denied. Grant Microsoft.EventGrid/events/receive/action on this namespace or topic." : "Event Grid did not confirm this operation. No request was retried.";
	public async Task<EventGridPullOutcome> ReceiveAsync(EventGridReceive p, string stamp, Func<EventGridPullProgress, Task> emit, CancellationToken cancellation)
	{
		PullTarget(p.Target);
		if (!Guid.TryParse(p.Id, out _) || p.MaxEvents is < 1 or > 100 || p.BatchSize is < 1 or > 10 || p.MaxWaitSeconds is < 10 or > 120 || p.MaxSeconds is < 1 or > 300 || !p.Acknowledged)
			throw PullBad();
		if (SavedPull(p.Id, stamp, out var prior))
			return prior!;
		if (held.Count + p.MaxEvents > 100)
			throw new OperationException(OperationFailure.OperationBlocked, "At most 100 event snapshots can be retained per connection. Settle events and clear finished snapshots, or lower the receive count.");
		var clock = Stopwatch.StartNew();
		var handles = new List<string>();
		var uncertain = 0;
		var status = "completed";
		var reason = "count";
		var dispatched = false;
		var batch = 0;
		var summary = "";
		using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
		deadline.CancelAfter(TimeSpan.FromSeconds(p.MaxSeconds));
		async Task Progress(string phase)
		{
			try
			{
				await emit(new EventGridPullProgress(p.Id, "receive", p.MaxEvents, handles.Count, 0, uncertain, clock.ElapsedMilliseconds, phase));
			}
			catch { }
		}
		await Progress("validating");
		try
		{
			var details = await gateway!.AdminGetAsync(p.Target, deadline.Token);
			if (details.Settings?.DeliveryMode != "Queue")
				throw new OperationException(OperationFailure.InvalidInput, "Pull receiving requires a Queue delivery subscription. Push subscriptions cannot be received here.");
			var duration = details.Settings.ReceiveLockDurationInSeconds ?? 60;
			while (handles.Count < p.MaxEvents)
			{
				deadline.Token.ThrowIfCancellationRequested();
				batch = Math.Min(p.BatchSize, p.MaxEvents - handles.Count);
				dispatched = false;
				await Progress("receiving");
				var first = PullNow;
				var response = await gateway.ReceiveAsync(p.Target, batch, p.MaxWaitSeconds, () => { dispatched = true; }, deadline.Token);
				var items = response.Events;
				if (items.Count > batch)
					throw new IOException("Invalid receive result.");
				var staged = new List<HeldEvent>();
				var tokens = new HashSet<EventGridLockToken>();
				foreach (var row in items)
				{
					var token = row.Token;
					var count = row.DeliveryCount;
					using var document = JsonDocument.Parse(row.EventJson);
					var ev = document.RootElement;
					if (!tokens.Add(token) || held.Values.Any(v => token.Equals(v.Token)) || count < 1 || ev.ValueKind != JsonValueKind.Object)
						throw new IOException("Invalid receive result.");
					var raw = ev.GetRawText();
					var bytes = Encoding.UTF8.GetByteCount(raw);
					if (bytes > 1048576)
						throw new IOException("Oversized CloudEvent.");
					static string Attr(JsonElement e, string key, bool required = false)
					{
						if (!e.TryGetProperty(key, out var v))
						{
							if (required)
								throw new IOException("Incomplete CloudEvent.");
							return "";
						}
						var s = v.GetString() ?? "";
						if (required && s.Length == 0)
							throw new IOException("Incomplete CloudEvent.");
						return s.Length > 256 ? s[..(char.IsHighSurrogate(s[255]) ? 255 : 256)] + "…" : s;
					}
					if (Attr(ev, "specversion", true) != "1.0")
						throw new IOException("Unsupported CloudEvent.");
					var item = new EventGridReceived(Guid.NewGuid().ToString(), p.Target, Attr(ev, "id", true), Attr(ev, "source", true), Attr(ev, "type", true), Attr(ev, "subject"), count, MsgCommander.Application.Common.DisplayValues.Timestamp(PullNow), MsgCommander.Application.Common.DisplayValues.Timestamp(first.AddSeconds(duration)), "held", bytes);
					staged.Add(new(item, token, raw, duration, first));
				}
				foreach (var value in staged)
				{
					Expire(value);
					held.Add(value.Item.Handle, value);
					handles.Add(value.Item.Handle);
				}
				dispatched = false;
				await Progress("receiving");
				if (staged.Count == 0)
				{
					reason = "empty";
					status = "limited";
					break;
				}
			}
		}
		catch (Exception e)
		{
			uncertain = dispatched && !Rejected(e) ? batch : 0;
			var stopped = e is OperationCanceledException && deadline.IsCancellationRequested;
			status = uncertain > 0 ? "unknown" : stopped ? (cancellation.IsCancellationRequested ? "cancelled" : "limited") : "failed";
			reason = stopped ? (cancellation.IsCancellationRequested ? "cancelled" : "time") : "error";
			summary = uncertain > 0 ? "A receive response was lost or incomplete; additional events may remain locked until Azure expires their locks. Recover this receipt and refresh retained events before receiving again." : e is OperationException pe ? pe.Message : PullFailure(e);
		}
		summary = $"{handles.Count}/{p.MaxEvents} events retained; {uncertain} possible additional locks. " + (summary != "" ? summary : reason == "empty" ? "Azure returned no events. This is not a guaranteed empty subscription." : "No events were automatically acknowledged. Locks expire unless settled or renewed.");
		var result = new EventGridPullOutcome(p.Id, p.Target, "receive", p.MaxEvents, handles.Count, 0, uncertain, clock.ElapsedMilliseconds, status, reason, summary, handles.ToArray(), []);
		pulls.Add(p.Id, (stamp, result));
		await Progress("finished");
		return result;
	}
	public async Task<EventGridPullOutcome> SettleAsync(EventGridSettle p, string stamp, Func<EventGridPullProgress, Task> emit, CancellationToken cancellation)
	{
		PullTarget(p.Target);
		if (!Guid.TryParse(p.Id, out _) || !p.Acknowledged || p.Action is not ("acknowledge" or "release" or "reject" or "renewLock") || p.Handles is null || p.Handles.Count is < 1 or > 100 || p.Handles.Any(h => !Guid.TryParse(h, out _)) || p.Handles.Distinct().Count() != p.Handles.Count || !new[] { 0, 10, 60, 600, 3600 }.Contains(p.ReleaseDelaySeconds) || (p.Action != "release" && p.ReleaseDelaySeconds != 0))
			throw PullBad();
		if (SavedPull(p.Id, stamp, out var prior))
			return prior!;
		var values = p.Handles.Select(h => FindHeld(p.Target, h)).ToArray();
		if (values.Any(v => v.Item.State != "held" || v.Token is null || p.Action == "renewLock" && PullNow - v.First >= TimeSpan.FromHours(1)))
			throw new OperationException(OperationFailure.InvalidInput, "Only held events with an unexpired estimated lock can be settled. Renewal is available within one hour of the original receive. Refresh received events.");
		var clock = Stopwatch.StartNew();
		var dispatched = false;
		var first = PullNow;
		var confirmed = 0;
		var failed = 0;
		var uncertain = 0;
		var status = "completed";
		var reason = "count";
		var results = new List<EventGridSettlementResult>();
		var summary = "";
		async Task Progress(string phase)
		{
			try
			{
				await emit(new EventGridPullProgress(p.Id, p.Action, p.Handles.Count, confirmed, failed, uncertain, clock.ElapsedMilliseconds, phase));
			}
			catch { }
		}
		using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
		deadline.CancelAfter(TimeSpan.FromSeconds(60));
		await Progress("settling");
		try
		{
			var tokens = values.Select(v => v.Token!).ToArray();
			var response = await gateway!.SettleAsync(p.Target, p.Action, p.ReleaseDelaySeconds, tokens, () => { dispatched = true; }, deadline.Token);
			if (response.Succeeded.Count + response.Failed.Count > 100)
				throw new IOException("Invalid settlement result.");
			var answers = new Dictionary<EventGridLockToken, (bool Success, string? Code)>();
			foreach (var item in response.Succeeded)
				if (!answers.TryAdd(item, (true, null)))
					throw new IOException("Duplicate result token.");
			foreach (var item in response.Failed)
				if (!answers.TryAdd(item.Token, (false, Enum.IsDefined(item.Code) ? item.Code.ToString() : "SettlementFailed")))
					throw new IOException("Duplicate result token.");
			if (answers.Keys.Any(t => !tokens.Contains(t)))
				throw new IOException("Unrelated settlement result.");
			foreach (var value in values)
			{
				if (!answers.TryGetValue(value.Token!, out var answer))
				{
					value.Item = value.Item with
					{
						State = "unknown"
					};
					value.Token = null;
					uncertain++;
					results.Add(new(value.Item.Handle, "unknown", null));
					continue;
				}
				if (answer.Success)
				{
					confirmed++;
					value.Item = value.Item with
					{
						State = p.Action == "renewLock" ? "held" : p.Action == "acknowledge" ? "acknowledged" : p.Action == "release" ? "released" : "rejected",
						EstimatedLockedUntil = p.Action == "renewLock" ? MsgCommander.Application.Common.DisplayValues.Timestamp(first.AddSeconds(value.Duration)) : value.Item.EstimatedLockedUntil
					};
					if (p.Action != "renewLock")
						value.Token = null;
					Expire(value);
					results.Add(new(value.Item.Handle, "succeeded", null));
				}
				else
				{
					failed++;
					if (answer.Code is "BadToken" or "TokenLost" or "LockLost" or "LockTokenExpired")
					{
						value.Item = value.Item with
						{
							State = "lock-lost"
						};
						value.Token = null;
					}
					results.Add(new(value.Item.Handle, "failed", answer.Code));
				}
			}
			status = uncertain > 0 ? "unknown" : failed > 0 ? "failed" : "completed";
			if (uncertain > 0)
			{
				reason = "error";
				summary = "Azure did not return a conclusive result for every selected handle. Unknown handles cannot be reused; nothing was retried.";
			}
			else if (failed > 0)
			{
				reason = "error";
				summary = "Review the per-event error codes. Confirmed successes were retained.";
			}
		}
		catch (Exception e)
		{
			uncertain = dispatched && !Rejected(e) ? values.Length : 0;
			var stopped = e is OperationCanceledException && deadline.IsCancellationRequested;
			status = uncertain > 0 ? "unknown" : stopped ? (cancellation.IsCancellationRequested ? "cancelled" : "limited") : "failed";
			reason = stopped ? (cancellation.IsCancellationRequested ? "cancelled" : "time") : "error";
			summary = uncertain > 0 ? "The settlement response is unavailable or ambiguous. These handles cannot be reused; do not assume success or failure. Nothing was retried." : PullFailure(e);
			foreach (var value in values)
			{
				if (uncertain > 0)
				{
					value.Item = value.Item with
					{
						State = "unknown"
					};
					value.Token = null;
				}
				results.Add(new(value.Item.Handle, uncertain > 0 ? "unknown" : dispatched ? "failed" : "not-attempted", null));
			}
			if (dispatched && uncertain == 0)
				failed = values.Length;
		}
		summary = $"{p.Action}: {confirmed}/{values.Length} confirmed, {failed} failed, {uncertain} uncertain. " + summary;
		var result = new EventGridPullOutcome(p.Id, p.Target, p.Action, values.Length, confirmed, failed, uncertain, clock.ElapsedMilliseconds, status, reason, summary, p.Handles.ToArray(), results.ToArray());
		pulls.Add(p.Id, (stamp, result));
		await Progress("finished");
		return result;
	}
}
