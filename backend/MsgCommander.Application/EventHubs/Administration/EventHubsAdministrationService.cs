using MsgCommander.Application.Common;
using MsgCommander.Application.EventHubs.Gateways;
using MsgCommander.Application.EventHubs.Messaging;
using MsgCommander.Contracts.EventHubs.Administration;

namespace MsgCommander.Application.EventHubs.Administration;

public sealed class EventHubsAdministrationService(IEventHubsGateway gateway, IEventHubsFailureClassifier failures)
{
	public EventAdminOutcome? GetResult(string id) => adminOutcomes.TryGetValue(id, out var prior) ? prior.Result : null;
	public void Clear()
	{
		adminOutcomes.Clear();
		policyCursors.Clear();
	}
	private readonly Dictionary<string, (string Fingerprint, EventAdminOutcome Result)> adminOutcomes = [];
	private readonly Dictionary<string, (string Hub, string Token)> policyCursors = [];
	public IEventHubsAdministration Admin => gateway.Administration ?? throw new OperationException(OperationFailure.AuthenticationRequired, "Reconnect with Entra management access to administer hubs, consumer groups and SAS policies. Data-plane SAS rights are separate.");
	public async Task<EventPolicyPage> PoliciesAsync(string hub, string? cursor, CancellationToken cancellation)
	{
		if (hub.Length > 0)
			EventHubsValidation.Name(hub);
		string? token = null;
		if (cursor is not null)
		{
			if (!policyCursors.TryGetValue(cursor, out var prior) || prior.Hub != hub)
				throw new OperationException(OperationFailure.InvalidInput, "Policy cursor expired or belongs to another scope.");
			token = prior.Token;
		}
		if (policyCursors.Count >= 1000)
			throw new OperationException(OperationFailure.OperationBlocked, "Policy cursor limit reached. Reconnect after reviewing results.");
		var page = await Admin.PoliciesAsync(hub, token, cancellation);
		if (page.Items.Count > 100)
			throw new OperationException(OperationFailure.OperationBlocked, "Policy page exceeds the local display limit.");
		var next = page.ContinuationToken is null ? null : Guid.NewGuid().ToString();
		if (next is not null)
			policyCursors.Add(next, (hub, page.ContinuationToken!));
		return page with
		{
			ContinuationToken = next
		};
	}
	public async Task<EventAdminOutcome> ChangeAsync(EventAdminChange change, string stamp, CancellationToken cancellation)
	{
		change.Validate();
		if (adminOutcomes.TryGetValue(change.Id, out var saved))
		{
			if (saved.Fingerprint != stamp)
				throw new OperationException(OperationFailure.InvalidInput, "Administration operation ID belongs to another request.");
			return saved.Result;
		}
		if (adminOutcomes.Count >= 100)
			throw new OperationException(OperationFailure.OperationBlocked, "Administration receipt limit reached. Review results before reconnecting.");
		var admin = Admin;
		var dispatched = false;
		var status = "confirmed";
		var summary = $"{change.Action} confirmed for {change.Target.Path()}.";
		try
		{
			await admin.ChangeAsync(change, () => dispatched = true, cancellation);
		}
		catch (Exception error)
		{
			var failure = failures.Classify(error, EventFailureOperation.Administration);
			var rejected = failure.Rejected;
			status = dispatched && !rejected ? "unknown" : error is OperationCanceledException && cancellation.IsCancellationRequested ? "cancelled" : "failed";
			summary = status == "unknown" ? "Azure may have accepted this change. Nothing was retried. Check the receipt and current Azure state before another change; key rotation cannot be safely inferred from unchanged policy rights."
				: status == "cancelled" ? "Cancelled before a write was dispatched."
				: error is OperationException protocol ? protocol.Message
				: failure.Denied ? "Azure denied this management action. Check the Entra identity's resource write/delete, listKeys or regenerateKeys permissions."
				: failure.NotFound ? "The resource no longer exists. Refresh the resource list."
				: "Azure rejected the change or preflight failed. Check settings, tier limits, storage/identity permissions and connectivity. Nothing was retried.";
		}
		var result = new EventAdminOutcome(change.Id, change.Target, change.Action, status, summary);
		adminOutcomes.Add(change.Id, (stamp, result));
		return result;
	}
}
