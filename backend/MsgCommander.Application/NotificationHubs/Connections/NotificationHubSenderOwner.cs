using MsgCommander.Application.Common;
using MsgCommander.Application.NotificationHubs.Gateways;
using MsgCommander.Application.NotificationHubs.RegistrationFiles;
using MsgCommander.Contracts.NotificationHubs.Registrations;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Application.NotificationHubs.Connections;

public sealed class NotificationHubSenderOwner(INotificationHubRegistrationsGatewayFactory factory, INotificationHubManagementAccess management, TimeProvider? timeProvider = null) : IAsyncDisposable
{
	private readonly SemaphoreSlim gate = new(1);
	private readonly HashSet<INotificationHubRegistrationsGateway> pending = new(ReferenceEqualityComparer.Instance);
	private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
	private NotificationHubSenderContext? current;
	private bool disposed;
	public NotificationHubRegistrationsConnection? Connection => current?.Connection;

	private static OperationException Expired() => new(OperationFailure.ConnectionExpired, "Notification sender connection expired. Connect again.");
	public async Task<NotificationHubRegistrationsConnection> ConnectAsync(Func<NotificationHubDataConnect> readRequest, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			var request = readRequest();
			NotificationHubDataAuthentication.Validate(request);
			await CloseAsync();
			if (pending.Count != 0)
				throw new OperationException(OperationFailure.OperationBlocked, "Notification Hubs client cleanup could not be confirmed. Retry connecting explicitly; restart the backend if cleanup keeps failing.");
			var profile = await NotificationHubDataAuthentication.CredentialAsync(request, management, true, cancellation);
			INotificationHubRegistrationsGateway? candidate = factory.Create(profile, request.Setup.HubName);
			try
			{
				cancellation.ThrowIfCancellationRequested();
				var setup = request.Setup;
				var connection = new NotificationHubRegistrationsConnection(Guid.NewGuid().ToString(), profile.Id, profile.Namespace, setup.HubName, setup.Source, setup.ManagementConnectionId, Timestamp(clock.GetUtcNow()));
				current = new(candidate, connection, clock);
				candidate = null;
				return connection;
			}
			finally
			{
				if (candidate is not null)
					await DisposeGatewayAsync(candidate);
			}
		}
		finally
		{
			gate.Release();
		}
	}

	public async Task<T> ExecuteAsync<T>(string? connectionId, string? operationId, Func<NotificationHubSenderContext, CancellationToken, Task<T>> action, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			var context = current;
			if (context is null || context.Connection.ConnectionId != connectionId)
				throw Expired();
			NotificationHubDataAuthentication.Operation(operationId);
			if (context.Connection.ManagementConnectionId is { } admin)
				await management.RequireAsync(admin, context.Connection.ProfileId, cancellation);
			return await action(context, cancellation);
		}
		finally
		{
			gate.Release();
		}
	}

	public async Task DisconnectAsync(string? connectionId, string? operationId, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			if (current is null || current.Connection.ConnectionId != connectionId)
				throw Expired();
			NotificationHubDataAuthentication.Operation(operationId);
			await CloseAsync();
		}
		finally
		{
			gate.Release();
		}
	}

	public async Task ResetAsync(CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			await CloseAsync();
		}
		finally
		{
			gate.Release();
		}
	}

	private async Task DisposeGatewayAsync(INotificationHubRegistrationsGateway gateway)
	{
		try
		{
			await gateway.DisposeAsync();
			pending.Remove(gateway);
		}
		catch
		{
			pending.Add(gateway);
		}
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
		finally
		{
			gate.Release();
		}
	}
}
