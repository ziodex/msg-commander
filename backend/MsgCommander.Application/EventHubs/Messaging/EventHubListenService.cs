using MsgCommander.Application.Common;
using MsgCommander.Application.EventHubs.Connections;
using MsgCommander.Application.EventHubs.Gateways;
using MsgCommander.Contracts.EventHubs.Browsing;
using MsgCommander.Contracts.EventHubs.Messaging;

namespace MsgCommander.Application.EventHubs.Messaging;

public sealed class EventHubListenService(IEventHubsGateway gateway, EventHubsConnection connection,
	EventSnapshotStore store, EventHubResourceCleanup cleanup)
{
	private readonly Dictionary<string, (string Fingerprint, EventListenResult Result)> listens = [];
	public EventListenResult? GetResult(string id) => listens.TryGetValue(id, out var saved) ? saved.Result : null;
	public void Clear() => listens.Clear();

	public async Task<EventListenResult> ExecuteAsync(EventListenRequest request, string fingerprint,
		Func<EventListenProgress, Task> emit, CancellationToken cancellation)
	{
		if (connection.Access == "send")
			throw new OperationException(OperationFailure.InvalidInput, "Reconnect in read mode to listen. No receiver was opened.");
		if (!Guid.TryParse(request.Id, out _) || !request.Acknowledged || request.Concurrency is < 1 or > 16 ||
			request.MaxEvents is < 1 or > 1000 || request.MaxSeconds is < 1 or > 3600)
			throw new OperationException(OperationFailure.InvalidInput, "Acknowledge listening and use 1–16 receivers, 1–1,000 events and 1–3,600 seconds.");
		EventHubsValidation.Name(request.HubName);
		EventHubsValidation.Name(request.ConsumerGroup, true);
		var checkpoint = EventListenerPlan.ValidateStart(request, connection);
		if (listens.TryGetValue(request.Id, out var saved))
		{
			if (saved.Fingerprint != fingerprint)
				throw new OperationException(OperationFailure.InvalidInput, "Listener ID belongs to another request.");
			return saved.Result;
		}
		if (listens.Count >= 100 || cleanup.HasFailures)
			throw new OperationException(OperationFailure.OperationBlocked, "Listener receipt limit or unresolved receiver cleanup. Disconnect after reviewing results; restart the backend if cleanup still fails.");
		using var run = new EventListenerRun(gateway, connection, store, cleanup, request, emit, cancellation);
		var result = await run.ExecuteAsync(checkpoint);
		listens.Add(request.Id, (fingerprint, result));
		await run.ProgressAsync("finished", true);
		return result;
	}
}
