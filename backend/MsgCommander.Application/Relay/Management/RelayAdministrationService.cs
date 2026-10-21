using System.Text;
using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.Relay.Gateways;
using MsgCommander.Application.Relay.Management;
using MsgCommander.Contracts.Relay.Management;
using MsgCommander.Contracts.Relay.Configuration;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Application.Relay.Management;

public sealed class RelayAdministrationService(IRelayGateway gateway, IRelayFailureClassifier failures)
{
	private readonly OperationReceipts<RelayOutcome> receipts = new(100, "Relay operation ID belongs to another request.", "Relay receipt limit reached. Review results before reconnecting.");
	public void Clear() => receipts.Clear();
	public RelayOutcome? GetResult(string id) => receipts.Get(id);
	public async Task<RelayOutcome> ChangeAsync(RelayChange change, string stamp, CancellationToken cancellation)
	{
		change.Validate();
		if (receipts.CheckRequest(change.Id, stamp) is { } saved)
			return saved;
		var result = await ApplyAsync(change, cancellation);
		receipts.Add(change.Id, stamp, result);
		return result;
	}

	public async Task<RelayOutcome> ApplyAsync(RelayChange change, CancellationToken cancellation)
	{
		var dispatched = false;
		var status = "confirmed";
		var summary = $"{change.Action} confirmed for {change.Target.Display}.";
		try
		{
			await gateway!.ChangeAsync(change, () => dispatched = true, cancellation);
		}
		catch (Exception error)
		{
			var failure = failures.Classify(error);
			var rejected = failure.Rejected;
			status = dispatched && !rejected ? "unknown" : error is OperationCanceledException && cancellation.IsCancellationRequested ? "cancelled" : "failed";
			summary = status == "unknown" ? "Azure may have accepted this change. Nothing was retried. Check the retained receipt and Azure state before another change; unchanged policy rights cannot prove whether keys rotated." : status == "cancelled" ? "Cancelled before a write was dispatched." : error is OperationException protocol ? protocol.Message : failure.Denied ? "Azure denied this Relay action. Check Entra resource write/delete, listKeys or regenerateKeys permissions." : "Relay change failed or was rejected. Refresh and review resource settings, permissions and connectivity. Nothing was retried.";
		}

		return new RelayOutcome(change.Id, change.Target, change.Action, status, summary);
	}
}
