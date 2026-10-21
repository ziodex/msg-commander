using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Contracts.ServiceBus.Listeners;

namespace MsgCommander.Application.ServiceBus.Listeners;

/// <summary>Owns listener start receipts and draining under the connection operation gate.</summary>
public sealed class ListenerCoordinator(IMessageFailureClassifier failures)
{
	private volatile IMessageListener? listener;
	private readonly HashSet<string> startedListeners = [];
	public IMessageListener? Current => listener;

	public async Task<ListenerState> StartAsync(string connectionId, ListenerStart request, string fingerprint,
		IServiceBusMessagingGateway gateway, bool hasOwnedReceiver,
		Func<long, string?, string?>? recordDeferred, CancellationToken cancellation)
	{
		var id = request.Id;
		var target = request.Target;
		target.Validate(peek: true);
		var mode = request.Mode;
		var sessionId = request.SessionId;
		var sessionMode = request.SessionMode;
		var concurrency = request.MaxConcurrentSessions;
		var idleSeconds = request.SessionIdleSeconds;
		if (sessionMode is not ("single" or "next-available") || concurrency is < 1 or > 8 || idleSeconds is < 1 or > 30 ||
			(sessionMode == "next-available" && sessionId.Length != 0) || (sessionMode == "single" && concurrency != 1))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid session selection. Use 1–8 concurrent sessions and 1–30 idle seconds; automatic selection cannot specify a session ID.");
		var maxMessages = request.MaxMessages;
		var maxSeconds = request.MaxSeconds;
		var maxLockSeconds = request.MaxLockSeconds;
		if (!Guid.TryParse(id, out _) || mode is not ("manual" or "auto-complete") || sessionId.Length > 128 || maxMessages is < 1 or > 100000 ||
			(mode == "manual" && maxMessages > 1000) || maxSeconds is < 1 or > 86400 || maxLockSeconds is < 1 or > 3600)
			throw new OperationException(OperationFailure.InvalidInput, "Invalid listener settings or limits.");
		if (listener?.Id == id)
		{
			if (listener.Fingerprint != fingerprint)
				throw new OperationException(OperationFailure.InvalidInput, "Listener ID was reused with different settings.");
			return listener.Snapshot();
		}
		if (startedListeners.Contains(id))
			throw new OperationException(OperationFailure.OperationBlocked, "This listener request has expired. It will not be restarted. Refresh the listener state.");
		if (startedListeners.Count >= 1000)
			throw new OperationException(OperationFailure.OperationBlocked, "Listener start receipt limit reached. Reconnect before starting another listener.");
		if (listener?.Active == true)
			throw new OperationException(OperationFailure.OperationBlocked, "Stop the current listener before starting another.");
		if (hasOwnedReceiver)
			throw new OperationException(OperationFailure.OperationBlocked, "Close the current message or session receiver before starting a listener.");
		if (listener is not null)
			await listener.Stop();
		var entity = await gateway.GetEntityAsync(target, cancellation);
		if (sessionMode == "next-available")
		{
			if (entity.Entity.RequiresSession != true)
				throw new OperationException(OperationFailure.InvalidInput, "Automatic session selection requires a session-enabled queue or subscription.");
			cancellation.ThrowIfCancellationRequested();
			listener = new MultiSessionListener(id, connectionId, target, mode, maxMessages, maxSeconds, maxLockSeconds, concurrency, idleSeconds, gateway, failures, recordDeferred) { Fingerprint = fingerprint };
			startedListeners.Add(id);
			listener.Start();
			return listener.Snapshot();
		}
		if (entity.Entity.RequiresSession == true && string.IsNullOrWhiteSpace(sessionId))
			throw new OperationException(OperationFailure.InvalidInput, "Enter a session ID for this session-enabled source.");
		if (entity.Entity.RequiresSession == false && sessionId.Length > 0)
			throw new OperationException(OperationFailure.InvalidInput, "This source does not use sessions. Clear the session ID.");
		var receiver = await gateway.OpenReceiverAsync(target, "active", sessionId, cancellation);
		if (cancellation.IsCancellationRequested)
		{
			await receiver.DisposeAsync();
			cancellation.ThrowIfCancellationRequested();
		}
		listener = new MessageListener(id, connectionId, target, mode, maxMessages, maxSeconds, maxLockSeconds, receiver, failures, recordDeferred) { Fingerprint = fingerprint };
		startedListeners.Add(id);
		listener.Start();
		return listener.Snapshot();
	}

	public async ValueTask ClearAsync()
	{
		var previous = listener;
		listener = null;
		try
		{
			if (previous is not null)
				await previous.Stop();
		}
		finally { startedListeners.Clear(); }
	}
}
