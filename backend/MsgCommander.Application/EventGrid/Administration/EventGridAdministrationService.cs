using MsgCommander.Application.Common;
using MsgCommander.Application.EventGrid.Gateways;
using MsgCommander.Contracts.EventGrid.Administration;

namespace MsgCommander.Application.EventGrid.Administration;

public sealed class EventGridAdministrationService(IEventGridGateway gateway, IEventGridFailureClassifier failures)
{
	public void Clear() => outcomes.Clear();
	public EventGridAdminOutcome? GetResult(string id)
	{
		if (!Guid.TryParse(id, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid receipt ID.");
		return outcomes.TryGetValue(id, out var saved) ? saved.Result : null;
	}
	private readonly Dictionary<string, (string Stamp, EventGridAdminOutcome Result)> outcomes = [];
	public async Task<EventGridAdminOutcome> ChangeAsync(EventGridCommand change, string stamp, CancellationToken cancellation)
	{
		if (outcomes.TryGetValue(change.Id, out var saved))
		{
			if (saved.Stamp != stamp)
				throw new OperationException(OperationFailure.InvalidInput, "This operation ID belongs to another request.");
			return saved.Result;
		}
		if (outcomes.Count >= 100)
			throw new OperationException(OperationFailure.OperationBlocked, "Event Grid receipt limit reached. Review receipts before reconnecting.");
		var dispatched = false;
		string status, summary;
		try
		{
			status = await gateway!.ChangeAsync(change, () => dispatched = true, cancellation);
			summary = status == "failed" ? "Azure reported unsuccessful terminal provisioning. Inspect the resource before another change. Nothing was retried." : status == "confirmed" ? $"{change.Action} confirmed for {change.Target.SubscriptionName ?? change.Target.TopicName}." : "Azure accepted this change and may still be provisioning it. Refresh the resource to check its current state. Nothing was retried.";
		}
		catch (Exception e)
		{
			var failure = failures.Classify(e, EventGridFailureOperation.Administration);
			var rejected = failure.Rejected;
			status = dispatched && !rejected ? "unknown" : e is OperationCanceledException ? "cancelled" : "failed";
			summary = status == "unknown" ? "Azure may have accepted this change. Nothing was retried. Recover the retained receipt and inspect Azure before another change." : status == "cancelled" ? "Cancelled before dispatch. No write was sent." : e is OperationException p ? p.Message : failure.Denied ? "Azure denied this change. Check Entra ARM write/delete permissions on the namespace, topic and event subscriptions." : "Event Grid change failed or was rejected. Refresh and check settings, permissions and connectivity. Nothing was retried.";
		}
		var result = new EventGridAdminOutcome(change.Id, change.Target, change.Action, status, summary);
		outcomes.Add(change.Id, (stamp, result));
		return result;
	}
}
