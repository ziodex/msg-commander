using MsgCommander.Application.Common;
using MsgCommander.Application.Connections;
using MsgCommander.Application.EventHubs.Gateways;
using MsgCommander.Application.EventHubs.Messaging;
using MsgCommander.Application.ResourceConfiguration;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.EventHubs.Browsing;

namespace MsgCommander.Application.EventHubs.Connections;

public sealed class EventHubsConnectionOwner(IEventHubsGatewayFactory factory, IEventHubsFailureClassifier failures,
	IConfigurationFailureClassifier configurationFailures) : IAsyncDisposable
{
	private readonly SemaphoreSlim gate = new(1);
	private readonly EventHubResourceCleanup cleanup = new();
	private EventHubsConnectionContext? current;
	private bool disposed;
	public EventHubsConnection? Connection => current?.Connection;
	private static OperationException Expired() => new(OperationFailure.ConnectionExpired, "Event Hubs connection expired. Connect again.");
	private static OperationException IotAccess() => new(OperationFailure.AuthenticationRequired,
		"IoT Hub endpoint access failed. Check the current Built-in endpoints connection string, ServiceConnect policy, existing consumer group and AMQP WebSockets connectivity. No operation was retried.");

	// Parsing is deferred until after closing the previous generation, preserving replacement semantics.
	public async Task<EventHubsConnection> ConnectAsync(Func<EventHubConnect> readRequest,
		Func<DeviceCodeEvent, Task>? deviceCode, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		bool iot = current?.Connection.Service == "iot-hub";
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			await CloseAsync();
			if (cleanup.HasFailures)
				throw new OperationException(OperationFailure.OperationBlocked, "Client cleanup still could not be confirmed. Restart the backend before reconnecting Event Hubs.");
			var request = readRequest();
			var profile = request.Profile;
			var hub = request.HubName;
			iot = profile.Service == "iot-hub";
			if (request.Access is not ("read" or "send"))
				throw new OperationException(OperationFailure.InvalidInput, "Choose read or send connection access.");
			if (profile.Service is not ("event-hubs" or "iot-hub") || !Guid.TryParse(profile.Id, out _) || (hub.Length == 0 && request.Management is null))
				throw new OperationException(OperationFailure.InvalidInput, "Use an Event Hubs profile and a hub name or management connection.");
			if (iot)
			{
				var endpoint = IotHubEndpoint.Validate(profile);
				if (request.Access != "read" || request.Management is not null || hub != endpoint.HubName)
					throw new OperationException(OperationFailure.InvalidInput, "IoT Hub connections are read-only and scoped to the built-in EntityPath; Event Hubs administration and sending are unavailable.");
			}
			if (hub.Length > 0)
				EventHubsValidation.Name(hub);
			request.Management?.Validate(profile.Namespace);
			var prompts = new DeviceCodePrompts();
			IEventHubsGateway? candidate = null;
			try
			{
				using var scope = prompts.Enter(deviceCode, cancellation);
				candidate = await factory.ConnectAsync(profile, request.Management, prompts.ForwardAsync, cancellation);
				var initial = hub.Length > 0 ? await candidate.GetHubAsync(hub, cancellation, request.Access == "send") : null;
				cancellation.ThrowIfCancellationRequested();
				var connection = new EventHubsConnection(Guid.NewGuid().ToString(), profile.Id, profile.Namespace,
					DateTimeOffset.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture), candidate.CanBrowse, initial, request.Access, profile.Service);
				current = new(candidate, connection, cleanup, failures, configurationFailures, prompts);
				candidate = null;
				return connection;
			}
			finally
			{
				if (candidate is not null)
				{
					prompts.Close();
					await cleanup.CloseAsync(candidate);
				}
				else if (current is null)
					prompts.Close();
			}
		}
		catch (Exception error) when (iot && failures.IsIotAccessFailure(error)) { throw IotAccess(); }
		finally { gate.Release(); }
	}
	public async Task<T> ExecuteAsync<T>(string? connectionId, EventHubOperation operation, string? hubName,
		Func<DeviceCodeEvent, Task>? deviceCode, Func<EventHubsConnectionContext, CancellationToken, Task<T>> action, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		bool iot = false;
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			var context = current;
			if (context is null || context.Connection.ConnectionId != connectionId)
				throw Expired();
			iot = context.Connection.Service == "iot-hub";
			context.Require(operation, hubName);
			using var scope = context.Prompts.Enter(deviceCode, cancellation);
			return await action(context, cancellation);
		}
		catch (Exception error) when (iot && failures.IsIotAccessFailure(error)) { throw IotAccess(); }
		finally { gate.Release(); }
	}
	public async Task DisconnectAsync(string? connectionId, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			if (Connection?.ConnectionId != connectionId || current is null)
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
	private async Task CloseAsync()
	{
		var previous = current;
		current = null;
		previous?.Close();
		await cleanup.RetryAsync();
		if (previous is not null)
			await cleanup.CloseAsync(previous.Gateway);
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
