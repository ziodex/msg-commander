using MsgCommander.Application.Common;
using MsgCommander.Application.Connections;
using MsgCommander.Application.EventGrid.Gateways;
using MsgCommander.Application.EventGrid.Browsing;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.EventGrid.Browsing;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Application.EventGrid.Connections;

public sealed class EventGridConnectionOwner(IEventGridGatewayFactory factory, IEventGridFailureClassifier failures, TimeProvider? timeProvider = null) : IAsyncDisposable
{
	private readonly SemaphoreSlim gate = new(1);
	private readonly HashSet<IEventGridGateway> pending = new(ReferenceEqualityComparer.Instance);
	private EventGridConnectionContext? current;
	private bool disposed;
	public EventGridConnection? Connection => current?.Connection;
	private static OperationException Expired() => new(OperationFailure.ConnectionExpired, "Event Grid connection expired. Connect again.");
	public async Task<EventGridConnection> ConnectAsync(Func<EventGridConnect> readRequest, Func<DeviceCodeEvent, Task>? deviceCode, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			await CloseAsync();
			if (pending.Count != 0)
				throw new OperationException(OperationFailure.OperationBlocked, "Event Grid client cleanup could not be confirmed. Disconnect or restart the backend before reconnecting.");
			var request = readRequest();
			var profile = request.Profile;
			var management = request.Management;
			if (!Guid.TryParse(profile.Id, out _) || profile.Service != "event-grid" || profile.Auth != "device-code")
				throw new OperationException(OperationFailure.InvalidInput, "Choose an Event Grid Entra profile.");
			management.Validate(profile.Namespace);
			var prompts = new DeviceCodePrompts();
			IEventGridGateway? candidate = null;
			try
			{
				using var scope = prompts.Enter(deviceCode, cancellation);
				candidate = await factory.ConnectAsync(profile, management, prompts.ForwardAsync, cancellation);
				cancellation.ThrowIfCancellationRequested();
				var connection = new EventGridConnection(Guid.NewGuid().ToString(), profile.Id, profile.Namespace, management.ResourceId, candidate.Location, Timestamp(DateTimeOffset.UtcNow));
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
		finally { gate.Release(); }
	}
	public async Task<T> ExecuteAsync<T>(string? connectionId, Func<DeviceCodeEvent, Task>? deviceCode,
		Func<EventGridConnectionContext, CancellationToken, Task<T>> action, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			var context = current;
			if (context is null || context.Connection.ConnectionId != connectionId)
				throw Expired();
			using var scope = context.Prompts.Enter(deviceCode, cancellation);
			return await action(context, cancellation);
		}
		finally { gate.Release(); }
	}
	public async Task DisconnectAsync(string? connectionId, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			if (current is null || Connection?.ConnectionId != connectionId)
				throw Expired();
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
	private async Task DisposeGatewayAsync(IEventGridGateway gateway)
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
