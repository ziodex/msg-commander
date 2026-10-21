using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.NotificationHubs.Gateways;
using MsgCommander.Application.NotificationHubs.Management;
using MsgCommander.Contracts.NotificationHubs.Management;
using MsgCommander.Contracts.NotificationHubs.Configuration;
namespace MsgCommander.Application.NotificationHubs.Management;

public sealed class NotificationHubAdministrationService(INotificationHubGateway gateway, INotificationHubFailureClassifier failures, NotificationHubReceiptStore receipts)
{
	public async Task<NotificationHubOutcome> ChangeAsync(NotificationHubChange change, string stamp, CancellationToken cancellation)
	{
		change.Validate();
		if (receipts.Check(change.Id, stamp) is { } prior)
			return prior;
		var result = await ApplyAsync(change, cancellation);
		receipts.Add(change.Id, stamp, result);
		return result;
	}
	public async Task<NotificationHubOutcome> ApplyAsync(NotificationHubChange change, CancellationToken cancellation)
	{
		var dispatched = false;
		var status = "confirmed";
		var summary = $"{change.Action} confirmed for {change.Target.Display()}.";
		try
		{
			await gateway!.ChangeAsync(change, () => dispatched = true, cancellation);
		}
		catch (Exception error)
		{
			var failure = failures.Classify(error);
			var rejected = failure.Rejected;
			status = dispatched && !rejected ? "unknown" : error is OperationCanceledException && cancellation.IsCancellationRequested ? "cancelled" : "failed";
			summary = status == "unknown" ? "Azure may have accepted this change. Nothing was retried. Check the retained receipt and Azure state before another change; unchanged policy rights cannot prove whether keys rotated."
				: status == "cancelled" ? "Cancelled before a write was dispatched."
				: error is OperationException protocol ? protocol.Message
				: failure.Denied ? "Azure denied this Notification Hubs action. Check Entra resource write/delete, listKeys or regenerateKeys permissions."
				: "Notification Hubs change failed or was rejected. Refresh and review resource settings, permissions and connectivity. Nothing was retried.";
		}
		return new NotificationHubOutcome(change.Id, change.Target, change.Action, status, summary);
	}
}
