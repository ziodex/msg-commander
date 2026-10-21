using MsgCommander.Application.Common;
using MsgCommander.Application.Connections;
using MsgCommander.Application.ServiceBus.Gateways;
using MsgCommander.Application.ServiceBus.Listeners;
using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.ServiceBus.Listeners;
using MsgCommander.Contracts.ServiceBus.Messages;

namespace MsgCommander.Application.ServiceBus.Workspace;

public sealed class ServiceBusConnectionOwner : IAsyncDisposable
{
	private readonly IServiceBusGatewayFactory factory;
	private readonly ServiceBusFailurePolicies failures;
	private readonly ConnectionScope<ServiceBusConnectionContext, NamespaceConnection> lifetime;
	private int cleanupUnconfirmed;
	public DeferredReferenceService Deferred
	{
		get;
	}
	public NamespaceConnection? Connection => lifetime.Connection;
	public ServiceBusConnectionContext Current => lifetime.Client ?? throw Expired();
	private static OperationException Expired() => new(OperationFailure.ConnectionExpired, "Connection expired. Connect to the namespace again.");
	public ServiceBusConnectionOwner(IServiceBusGatewayFactory factory, ServiceBusFailurePolicies failures, IMessageDeferProvider deferred)
	{
		this.factory = factory;
		this.failures = failures;
		Deferred = new(deferred);
		lifetime = new(() => ValueTask.CompletedTask, state => state.ConnectionId, "Connection expired. Connect to the namespace again.");
	}
	public async Task<NamespaceConnection> ConnectAsync(ConnectionProfile profile, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		if (!Guid.TryParse(profile.Id, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid profile ID.");
		return await lifetime.ConnectAsync(async token =>
		{
			if (Volatile.Read(ref cleanupUnconfirmed) != 0)
				throw new OperationException(OperationFailure.OperationBlocked, "Connection cleanup could not be confirmed. Restart the backend before connecting again.");
			var prompts = new DeviceCodePrompts();
			using var request = prompts.Enter(deviceCode, token);
			var gateway = await factory.ConnectAsync(profile, prompts.ForwardAsync, token);
			try
			{
				return new ServiceBusConnectionContext(gateway, factory, profile.Id, profile.Namespace, failures, Deferred, prompts, () => Volatile.Write(ref cleanupUnconfirmed, 1));
			}
			catch { await gateway.DisposeAsync(); throw; }
		}, (id, context) => context.Describe(id), cancellation);
	}
	public async Task<T> ExecuteAsync<T>(string? connectionId, ServiceBusOperation operation, Func<DeviceCodeEvent, Task>? deviceCode,
		Func<ServiceBusConnectionContext, CancellationToken, Task<T>> action, CancellationToken cancellation)
	{
		try
		{
			return await lifetime.ExecuteAsync(connectionId, async (context, token) =>
			{
				context.Require(operation);
				using var request = context.Prompts.Enter(deviceCode, token);
				return await action(context, token);
			}, cancellation);
		}
		catch (ConnectionExpiredException) { throw Expired(); }
	}
	private IMessageListener? Listener(string? connectionId, string? listenerId = null, bool required = false)
	{
		var context = lifetime.Client;
		if (context is null || Connection?.ConnectionId != connectionId)
			throw Expired();
		context.Require(ServiceBusOperation.Shared);
		var current = context.Listener;
		if (current?.ConnectionId != connectionId)
			current = null;
		if (required && (current is null || current.Id != listenerId))
			throw new OperationException(OperationFailure.OperationBlocked, "Listener expired. Refresh the listener state.");
		return current;
	}
	public ListenerState? ListenerStatus(string? connectionId) => Listener(connectionId)?.Snapshot();
	public Task<ListenerState> StopListenerAsync(string? connectionId, string? listenerId) => Listener(connectionId, listenerId, true)!.Stop();
	public Task<ListenerState> SettleListenerAsync(string? connectionId, string? listenerId, ListenerSettlement request, string fingerprint, CancellationToken cancellation) =>
		Listener(connectionId, listenerId, true)!.Settle(request, fingerprint, cancellation);
	public Task DisconnectAsync(string? connectionId, CancellationToken cancellation) => lifetime.DisconnectAsync(connectionId, cancellation);
	public Task ResetAsync(CancellationToken cancellation) => lifetime.ResetAsync(cancellation);
	public ValueTask DisposeAsync() => lifetime.DisposeAsync();
}
