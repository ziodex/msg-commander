using MsgCommander.Application.Common;
using MsgCommander.Application.Connections;
using MsgCommander.Application.NotificationHubs.Credentials;
using MsgCommander.Application.NotificationHubs.Gateways;
using MsgCommander.Application.NotificationHubs.Management;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.NotificationHubs.Management;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Application.NotificationHubs.Connections;

public sealed class NotificationHubManagementOwner(INotificationHubGatewayFactory factory, IProviderCredentialCodec codec,
	INotificationHubFailureClassifier failures, TimeProvider? timeProvider = null) : INotificationHubManagementAccess, IAsyncDisposable
{
	private readonly SemaphoreSlim gate = new(1);
	private readonly HashSet<INotificationHubGateway> pending = new(ReferenceEqualityComparer.Instance);
	private NotificationHubManagementContext? current;
	private bool disposed;
	public NotificationHubConnection? Connection => current?.Connection;
	private static OperationException Expired() => new(OperationFailure.ConnectionExpired, "Notification Hubs connection expired. Connect again.");
	private static void Operation(string? id)
	{
		if (!Guid.TryParse(id, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid operation ID.");
	}
	public async Task<NotificationHubConnection> ConnectAsync(Func<NotificationHubManagementConnect> readRequest,
		Func<DeviceCodeEvent, Task>? deviceCode, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			await CloseAsync();
			if (pending.Count != 0)
				throw new OperationException(OperationFailure.OperationBlocked, "Notification Hubs client cleanup could not be confirmed. Retry connecting explicitly; restart the backend if cleanup keeps failing.");
			var request = readRequest();
			var profile = request.Profile;
			if (!Guid.TryParse(request.OperationId, out _) || !Guid.TryParse(profile.Id, out _) || profile.Service != "notification-hubs")
				throw new OperationException(OperationFailure.InvalidInput, "Use a Notification Hubs profile.");
			request.Management.Validate(profile.Namespace);
			var prompts = new DeviceCodePrompts();
			INotificationHubGateway? candidate = null;
			try
			{
				using var scope = prompts.Enter(deviceCode, cancellation);
				candidate = await factory.ConnectAsync(profile, request.Management, prompts.ForwardAsync, cancellation);
				cancellation.ThrowIfCancellationRequested();
				var connection = new NotificationHubConnection(Guid.NewGuid().ToString(), profile.Id, profile.Namespace, request.Management.ResourceId, Timestamp(DateTimeOffset.UtcNow), candidate.Location);
				current = new(candidate, connection, prompts, codec, failures, timeProvider);
				candidate = null;
				return connection;
			}
			finally
			{
				if (candidate is not null)
				{
					prompts.Close();
					await DisposeGatewayAsync(candidate);
				}
				else if (current is null)
					prompts.Close();
			}
		}
		finally { gate.Release(); }
	}
	public async Task<T> ExecuteAsync<T>(string? connectionId, string? operationId, Func<DeviceCodeEvent, Task>? deviceCode,
		Func<NotificationHubManagementContext, CancellationToken, Task<T>> action, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			var context = current;
			if (context is null || context.Connection.ConnectionId != connectionId)
				throw Expired();
			Operation(operationId);
			using var scope = context.Prompts.Enter(deviceCode, cancellation);
			return await action(context, cancellation);
		}
		finally { gate.Release(); }
	}
	private NotificationHubManagementContext Require(string id, string profileId)
	{
		ObjectDisposedException.ThrowIf(disposed, this);
		var context = current;
		if (context is null || context.Connection.ConnectionId != id || context.Connection.ProfileId != profileId)
			throw new OperationException(OperationFailure.ConnectionExpired, "Notification Hubs management connection expired. Reconnect before using its registration credential.");
		return context;
	}
	public async Task RequireAsync(string connectionId, string profileId, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			Require(connectionId, profileId);
		}
		finally { gate.Release(); }
	}
	public async Task<ConnectionProfile> CredentialAsync(NotificationHubPolicyCredential request, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			var context = Require(request.ManagementConnectionId, request.Profile.Id);
			if (context.Connection.Namespace != request.Profile.Namespace || request.Source != "policy")
				throw new OperationException(OperationFailure.InvalidInput, "Select a policy from the matching Notification Hubs management connection.");
			// This separate request cannot borrow a foreground editor's sign-in callback.
			using var scope = context.Prompts.Enter(null, cancellation);
			var details = await context.Gateway.GetAsync(request.Target, cancellation);
			if (details.Rights?.Contains("Manage") != true && (!request.Sending || details.Rights?.Contains("Send") != true))
				throw new OperationException(OperationFailure.AuthenticationRequired, request.Sending ? "Select a SAS policy with Send or Manage rights explicitly." : "Registration browsing requires a SAS policy with Manage rights. Select a Manage policy explicitly.");
			var credential = await context.Gateway.KeyAsync(request.Target, request.KeyType, cancellation);
			cancellation.ThrowIfCancellationRequested();
			return request.Profile with
			{
				Auth = "sas",
				Secret = credential.ConnectionString
			};
		}
		finally { gate.Release(); }
	}
	public async Task DisconnectAsync(string? connectionId, string? operationId, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			if (current is null || Connection?.ConnectionId != connectionId)
				throw Expired();
			Operation(operationId);
			await CloseAsync();
		}
		finally { gate.Release(); }
	}
	public async Task ResetAsync(CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			await CloseAsync();
		}
		finally { gate.Release(); }
	}
	private async Task DisposeGatewayAsync(INotificationHubGateway gateway)
	{
		try
		{
			await gateway.DisposeAsync();
			pending.Remove(gateway);
		}
		catch { pending.Add(gateway); }
	}
	private async Task CloseAsync()
	{
		var previous = current;
		current = null;
		previous?.Close();
		foreach (var gateway in pending.ToArray())
			await DisposeGatewayAsync(gateway);
		if (previous is not null)
			await DisposeGatewayAsync(previous.Gateway);
	}
	public async ValueTask DisposeAsync()
	{
		await gate.WaitAsync();
		try
		{
			if (disposed)
				return;
			disposed = true;
			await CloseAsync();
		}
		finally { gate.Release(); }
	}
}
