using MsgCommander.Application.Common;
using MsgCommander.Application.Connections;
using MsgCommander.Application.Relay.Gateways;
using MsgCommander.Application.Relay.Management;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.Relay.Management;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Application.Relay.Connections;

public sealed class RelayConnectionOwner(IRelayGatewayFactory factory, IRelayFailureClassifier failures, TimeProvider? timeProvider = null) : IAsyncDisposable
{
	private readonly SemaphoreSlim gate = new(1);
	private readonly HashSet<IRelayGateway> pending = new(ReferenceEqualityComparer.Instance);
	private RelayConnectionContext? current;
	private bool disposed;
	public RelayConnection? Connection => current?.Connection;

	private static OperationException Expired() => new(OperationFailure.ConnectionExpired, "Relay connection expired. Connect again.");
	private static void Operation(string? id)
	{
		if (!Guid.TryParse(id, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid operation ID.");
	}

	public async Task<RelayConnection> ConnectAsync(Func<RelayManagementConnect> readRequest, Func<DeviceCodeEvent, Task>? deviceCode, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			await CloseAsync();
			if (pending.Count != 0)
				throw new OperationException(OperationFailure.OperationBlocked, "Relay client cleanup could not be confirmed. Retry connecting explicitly; restart the backend if cleanup keeps failing.");
			var request = readRequest();
			var profile = request.Profile;
			if (!Guid.TryParse(request.OperationId, out _) || !Guid.TryParse(profile.Id, out _) || profile.Service != "relay")
				throw new OperationException(OperationFailure.InvalidInput, "Use a Relay profile.");
			request.Management.Validate(profile.Namespace);
			var prompts = new DeviceCodePrompts();
			IRelayGateway? candidate = null;
			try
			{
				using var scope = prompts.Enter(deviceCode, cancellation);
				candidate = await factory.ConnectAsync(profile, request.Management, prompts.ForwardAsync, cancellation);
				cancellation.ThrowIfCancellationRequested();
				var connection = new RelayConnection(Guid.NewGuid().ToString(), profile.Id, profile.Namespace, request.Management.ResourceId, Timestamp(DateTimeOffset.UtcNow), candidate.Location);
				current = new(candidate, connection, prompts, failures, timeProvider);
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
		finally
		{
			gate.Release();
		}
	}

	public async Task<T> ExecuteAsync<T>(string? connectionId, string? operationId, Func<DeviceCodeEvent, Task>? deviceCode, Func<RelayConnectionContext, CancellationToken, Task<T>> action, CancellationToken cancellation)
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
			if (current is null || Connection?.ConnectionId != connectionId)
				throw Expired();
			Operation(operationId);
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

	private async Task DisposeGatewayAsync(IRelayGateway gateway)
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
