using MsgCommander.Application.Common;
using MsgCommander.Application.NotificationHubs.Gateways;
using MsgCommander.Contracts.NotificationHubs.Registrations;

namespace MsgCommander.Application.NotificationHubs.Registrations;

public sealed class RegistrationAdministrationService(IRegistrationCatalogGateway gateway, RegistrationSnapshotStore snapshots)
{
	private readonly OperationReceipts<NotificationHubRegistrationOutcome> receipts = new(100, "Registration operation ID belongs to another request.", "Registration receipt limit reached. Review results before reconnecting.");
	public void Clear() => receipts.Clear();
	public NotificationHubRegistrationOutcome? GetResult(string id) => receipts.Get(id);
	public async Task<NotificationHubRegistrationOutcome> ChangeAsync(NotificationHubRegistrationChange change, string stamp, CancellationToken cancellation)
	{
		change.Validate();
		if (receipts.CheckRequest(change.Id, stamp) is { } prior)
			return prior;
		var original = change.SnapshotId is null ? null : snapshots.Get(change.SnapshotId);
		if (original is not null && !snapshots.IsEditable(original.Registration.SnapshotId))
			throw new OperationException(OperationFailure.InvalidInput, "Reload the registration before editing or deleting it.");
		var result = await ApplyAsync(change, original, cancellation);
		receipts.Add(change.Id, stamp, result);
		return result;
	}

	public async Task<NotificationHubRegistrationOutcome> ApplyAsync(NotificationHubRegistrationChange change, NotificationHubRegistrationDetails? original, CancellationToken cancellation)
	{
		var dispatched = false;
		var status = "confirmed";
		var summary = $"Registration {change.Action} confirmed.";
		NotificationHubRegistrationDetails? changed = null;
		try
		{
			changed = await gateway.ChangeAsync(change, original, () => dispatched = true, cancellation);
			if (changed is not null)
				snapshots.Remember(changed);
		}
		catch (Exception error)
		{
			var rejected = error is RegistrationRejectedException || !dispatched && error is (OperationException or ArgumentException);
			status = dispatched && !rejected ? "unknown" : error is OperationCanceledException && cancellation.IsCancellationRequested ? "cancelled" : "failed";
			summary = status == "unknown" ? "Azure may have accepted this registration change. Nothing was retried. Check Azure state before another write; a lost create response can leave a new registration with an unknown ID." : status == "cancelled" ? "Cancelled before a write was dispatched." : error is RegistrationRejectedException or OperationException ? error.Message : "Registration change failed before dispatch. Reload and review the definition.";
		}

		return new(change.Id, change.Action, status, summary, changed?.Registration.RegistrationId ?? original?.Registration.RegistrationId, changed?.Etag ?? original?.Etag, changed?.Registration.SnapshotId);
	}
}
