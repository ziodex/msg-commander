using MsgCommander.Application.Common;
using MsgCommander.Contracts.ServiceBus.Messages;
using MsgCommander.Contracts.ServiceBus.Entities;
using static MsgCommander.Application.Common.DisplayValues;
using static MsgCommander.Application.ServiceBus.Messages.MessageProjection;

namespace MsgCommander.Application.ServiceBus.Messages;

public sealed partial class InteractiveReceiverService
{
	private Held RequireDelivery(string id, MutationExecution execution)
	{
		CurrentDeliveries();
		if (!deliveries.TryGetValue(id, out var held) || held.State != "active" || ownedReceiver is null)
			throw new OperationException(OperationFailure.DeliveryExpired, "This message has no active owned lock. Refresh held messages; peek snapshots cannot be settled.");
		execution.DeliveryId = id;
		execution.MessageId = held.Message.MessageId;
		return held;
	}
	public async Task<MutationEffect> ReplayAsync(ReplayMessage request, MutationExecution execution, CancellationToken cancellation)
	{
		var held = RequireDelivery(request.DeliveryId, execution);
		if (receivedSubQueue == "active")
			throw new OperationException(OperationFailure.InvalidInput, "Replay requires a received dead-letter message.");
		OutgoingMessages.ValidateDestination(request.Destination);
		var outgoing = OutgoingMessages.Replay(held.Message, request.IdPolicy, request.MessageId);
		execution.MessageId = outgoing.MessageId;
		cancellation.ThrowIfCancellationRequested();
		execution.Dispatch();
		await ownedReceiver!.ReplayAsync(held.Message, request.Destination, outgoing, cancellation);
		held.State = "replayed";
		return new("Replay transaction committed: send and source completion were acknowledged together. Destination duplicate detection and topic filters still apply.");
	}
	public async Task<MutationEffect> SettleAsync(SettleMessage request, MutationExecution execution, CancellationToken cancellation)
	{
		var held = RequireDelivery(request.DeliveryId, execution);
		var action = request.Action;
		var reason = request.Reason;
		var description = request.Description;
		if (action is not ("complete" or "abandon" or "dead-letter" or "defer" or "renew") || reason.Length > 128 || description.Length > 2048)
			throw new OperationException(OperationFailure.InvalidInput, "Invalid settlement action or dead-letter details.");
		if (action == "dead-letter" && (receivedSubQueue != "active" || string.IsNullOrWhiteSpace(reason)))
			throw new OperationException(OperationFailure.InvalidInput, "Dead-letter requires a reason and a message from the main queue.");
		cancellation.ThrowIfCancellationRequested();
		execution.Dispatch();
		await ownedReceiver!.SettleAsync(held.Message, action, reason, description, cancellation);
		held.State = action switch
		{
			"complete" => "completed",
			"abandon" => "abandoned",
			"dead-letter" => "dead-lettered",
			"defer" => "deferred",
			_ => "active"
		};
		var warning = action == "defer" ? recordDeferred(receivedTarget!, receivedSubQueue, receivedSession, held.Message.SequenceNumber) : null;
		return new(action == "defer" ? warning ?? $"Message deferred. Sequence {held.Message.SequenceNumber} recorded for retrieval during this app session." : $"Broker acknowledged {action}.",
			action == "defer" ? [Number(held.Message.SequenceNumber)] : null);
	}
	public void ObserveMutationFailure(InteractiveMutation kind, MutationExecution execution, MutationFailure failure, string status)
	{
		if (failure.SessionLockLost)
		{
			sessionLockLost = true;
			CurrentSession();
		}
		if (kind == InteractiveMutation.SessionState && execution.Dispatched && status != "unknown")
			sessionStateUncertain = false;
		if (kind == InteractiveMutation.SessionRenew && status == "unknown")
			sessionLockUncertain = true;
		if (execution.DeliveryId is not null && deliveries.TryGetValue(execution.DeliveryId, out var held) && execution.Dispatched)
		{
			if (failure.LockLost)
				held.State = "lock-lost";
			else if (status == "unknown")
				held.State = "unknown";
			if (failure.SessionLockLost)
				foreach (var item in deliveries.Values.Where(item => item.State == "active"))
					item.State = "lock-lost";
		}
	}
}
