using MsgCommander.Application.Common;
using MsgCommander.Contracts.ServiceBus.Messages;
using MsgCommander.Contracts.ServiceBus.Entities;
using static MsgCommander.Application.Common.DisplayValues;
using static MsgCommander.Application.ServiceBus.Messages.MessageProjection;

namespace MsgCommander.Application.ServiceBus.Messages;

public sealed class MessageSendingService(IServiceBusMessagingGateway gateway, MessageInspectionService inspection)
{
	public async Task<MutationEffect> SendAsync(SendMessage request, MutationExecution execution, CancellationToken cancellation)
	{
		OutgoingMessages.ValidateDestination(request.Target);
		var outgoing = OutgoingMessages.Build(request.Draft);
		execution.MessageId = outgoing.MessageId;
		cancellation.ThrowIfCancellationRequested();
		execution.Dispatch();
		await gateway.SendAsync(request.Target, outgoing, cancellation);
		return new("Broker acknowledged the send. Duplicate detection and subscription rules still apply.");
	}
	public async Task<MutationEffect> SendBatchAsync(SendMessageBatch request, MutationExecution execution, CancellationToken cancellation)
	{
		var target = request.Target;
		OutgoingMessages.ValidateDestination(target);
		if (request.Drafts.Count is < 1 or > 20)
			throw new OperationException(OperationFailure.InvalidInput, "Use 1–20 messages and at most 512 KiB of serialized drafts per batch.");
		var outgoing = request.Drafts.Select(OutgoingMessages.Build).ToArray();
		BatchSending.Validate(outgoing);
		var scheduled = BatchSending.ParseTime(request.ScheduledEnqueueTime);
		var sequences = await gateway.SendBatchAsync(target, outgoing, scheduled, execution.Dispatch, cancellation);
		if (scheduled is not null && (sequences.Count != outgoing.Length || sequences.Any(sequence => sequence < 0)))
			throw new InvalidOperationException("Incomplete scheduling acknowledgement.");
		// Preserve the existing batch receipt: individual IDs appear only after an acknowledgement.
		execution.MessageId = outgoing.Length == 1 ? outgoing[0].MessageId : null;
		return new($"Broker acknowledged {outgoing.Length} message(s) {(scheduled is null ? "sent" : "scheduled for " + Timestamp(scheduled.Value))} to {target.Kind} / {target.Name}. Duplicate detection and subscription rules still apply.",
			scheduled is null ? null : sequences.Select(Number).ToArray());
	}
	public async Task<MutationEffect> CancelScheduledAsync(CancelScheduled request, MutationExecution execution, CancellationToken cancellation)
	{
		var target = request.Target;
		OutgoingMessages.ValidateDestination(target);
		var sequences = BatchSending.Sequences(request.SequenceNumbers.ToArray());
		if (request.Confirmation != $"{target.Kind}/{target.Name}")
			throw new OperationException(OperationFailure.InvalidInput, "Type the exact queue or topic path to confirm schedule cancellation.");
		await gateway.CancelScheduledAsync(target, sequences, execution.Dispatch, cancellation);
		inspection.Clear();
		return new($"Broker acknowledged cancellation for {request.SequenceNumbers.Count} scheduled sequence(s) on {target.Kind} / {target.Name}. Activation can race cancellation; refresh the scheduled view. Already activated messages cannot be recalled.", request.SequenceNumbers);
	}
	public async Task<MutationEffect> ResendAsync(ResendSnapshot request, MutationExecution execution, CancellationToken cancellation)
	{
		var original = inspection.Snapshot(request.SnapshotId).Message;
		OutgoingMessages.ValidateDestination(request.Destination);
		var outgoing = OutgoingMessages.Replay(original, request.IdPolicy, request.MessageId);
		execution.MessageId = outgoing.MessageId;
		cancellation.ThrowIfCancellationRequested();
		execution.Dispatch();
		await gateway.SendAsync(request.Destination, outgoing, cancellation);
		return new("Broker acknowledged the resent copy. The source was kept. Duplicate detection and subscription rules still apply.");
	}
}
