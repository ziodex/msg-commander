using MsgCommander.Application.Common;
using MsgCommander.Application.NotificationHubs.Gateways;
using MsgCommander.Contracts.NotificationHubs.Registrations;
using MsgCommander.Contracts.NotificationHubs.Jobs;
using MsgCommander.Contracts.NotificationHubs.Notifications;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Application.NotificationHubs.Notifications;

public sealed class NotificationSendService(INotificationSendGateway gateway, TimeProvider clock)
{
	private readonly OperationReceipts<NotificationSendOutcome> receipts = new(100, "Send operation ID belongs to another request.", "Send receipt limit reached. Review results before reconnecting.");
	public void Clear() => receipts.Clear();
	public NotificationSendOutcome? GetResult(string id) => receipts.Get(id);
	public async Task<NotificationSendOutcome> SendAsync(NotificationTestSend send, string stamp, CancellationToken cancellation)
	{
		send.Validate();
		send = send with
		{
			Draft = send.Draft with
			{
				Headers = Array.AsReadOnly(send.Draft.Headers.ToArray()),
				Parameters = Array.AsReadOnly(send.Draft.Parameters.ToArray())
			}
		};
		if (receipts.CheckRequest(send.Id, stamp) is { } prior)
			return prior;
		var dispatched = false;
		var status = "confirmed";
		var summary = "Azure acknowledged the test send. Inspect push-provider outcomes; application delivery is unverified.";
		NotificationSendDetails? details = null;
		try
		{
			details = await gateway.TestSendAsync(send.Draft, () => dispatched = true, cancellation);
			details = details with
			{
				Results = Array.AsReadOnly(details.Results.ToArray())
			};
		}
		catch (Exception error)
		{
			var rejected = error is NotificationSendRejectedException || !dispatched && error is OperationException or ArgumentException;
			status = dispatched && !rejected ? "unknown" : error is OperationCanceledException && cancellation.IsCancellationRequested ? "cancelled" : "failed";
			summary = status == "unknown" ? "Azure may have accepted this test send. Nothing was retried. Review the retained receipt and device/provider state before sending again." : status == "cancelled" ? "Cancelled before dispatch. No notification was sent." : error is NotificationSendRejectedException or OperationException ? error.Message : "Test send failed before dispatch. Review the notification and connection.";
		}

		var result = new NotificationSendOutcome(send.Id, status, summary, Timestamp(clock.GetUtcNow()), send.Draft, details);
		receipts.Add(send.Id, stamp, result);
		return result;
	}
}
