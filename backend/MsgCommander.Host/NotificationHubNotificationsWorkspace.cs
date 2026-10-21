using System.Text.Json;
using static MsgCommander.Host.NotificationHubDataRequests;

namespace MsgCommander.Host;

public sealed class NotificationHubNotificationsWorkspace : IAsyncDisposable
{
	private readonly NotificationHubSenderOwner owner;
	public NotificationHubNotificationsWorkspace(INotificationHubRegistrationsGatewayFactory factory, NotificationHubWorkspace management, TimeProvider? timeProvider = null) => owner = new(factory, management.Access, timeProvider);
	public async Task<object?> ExecuteAsync(string method, JsonElement input, CancellationToken cancellation)
	{
		if (method == "nh.notifications.reset")
		{
			await owner.ResetAsync(cancellation);
			return null;
		}

		if (method == "nh.notifications.connect")
			return await owner.ConnectAsync(() => Connect(input), cancellation);
		var connectionId = String(input, "connectionId");
		var operationId = String(input, "id");
		if (method == "nh.notifications.disconnect")
		{
			await owner.DisconnectAsync(connectionId, operationId, cancellation);
			return null;
		}

		return await owner.ExecuteAsync<object?>(connectionId, operationId, async (context, token) =>
		{
			if (method == "nh.notifications.result")
				return context.Sending.GetResult(String(input, "operationId") ?? "");
			if (method != "nh.notifications.send")
				throw new OperationException(OperationFailure.UnknownOperation, "Unknown notification send operation.");
			var send = Read<NotificationTestSend>(input);
			return await context.Sending.SendAsync(send, Fingerprint(send), token);
		}, cancellation);
	}

	public ValueTask DisposeAsync() => owner.DisposeAsync();
}
