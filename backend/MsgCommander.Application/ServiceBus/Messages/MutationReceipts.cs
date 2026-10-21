using MsgCommander.Application.Common;
using MsgCommander.Contracts.ServiceBus.Messages;
using MsgCommander.Contracts.ServiceBus.Entities;
using static MsgCommander.Application.Common.DisplayValues;
using static MsgCommander.Application.ServiceBus.Messages.MessageProjection;

namespace MsgCommander.Application.ServiceBus.Messages;

public enum MutationScope
{
	Messaging, Entity, Rule, Authorization
}
public enum InteractiveMutation
{
	Other, SessionState, SessionRenew
}
public sealed record MutationFailure(bool IsRejected, bool LockLost, bool SessionLockLost, string? SafeDescription);
public interface IMessageMutationFailureClassifier
{
	MutationFailure Classify(Exception error, MutationScope scope);
}
public sealed class MutationExecution
{
	public bool Dispatched
	{
		get; private set;
	}
	public string? MessageId
	{
		get; set;
	}
	public string? DeliveryId
	{
		get; set;
	}
	public void Dispatch() => Dispatched = true;
}
public sealed record MutationEffect(string Summary, IReadOnlyList<string>? SequenceNumbers = null);

/// <summary>Bounded connection receipts. The connection operation gate serializes callers.</summary>
public sealed class MutationReceipts(IMessageMutationFailureClassifier failures)
{
	private readonly Dictionary<string, (string Fingerprint, OperationOutcome Outcome)> receipts = [];
	public void Clear() => receipts.Clear();
	public OperationOutcome? Get(string operationId) => receipts.TryGetValue(operationId, out var entry) ? entry.Outcome : null;
	public async Task<OperationOutcome> ExecuteAsync(string operationId, string fingerprint, MutationScope scope,
		Func<MutationExecution, Task<MutationEffect>> execute,
		Action<MutationExecution, MutationFailure, string> failed, CancellationToken cancellation)
	{
		if (!Guid.TryParse(operationId, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid operation ID.");
		if (receipts.TryGetValue(operationId, out var existing))
		{
			if (existing.Fingerprint != fingerprint)
				throw new OperationException(OperationFailure.InvalidInput, "Operation ID was already used for a different request.");
			return existing.Outcome;
		}
		if (receipts.Count >= 1000)
			throw new OperationException(OperationFailure.OperationBlocked, "The connection receipt limit is reached. Reconnect after resolving pending work.");
		var execution = new MutationExecution();
		OperationOutcome result;
		try
		{
			cancellation.ThrowIfCancellationRequested();
			var effect = await execute(execution);
			result = new(operationId, "confirmed", effect.Summary, execution.MessageId, effect.SequenceNumbers);
		}
		catch (Exception error)
		{
			var failure = failures.Classify(error, scope);
			var status = !execution.Dispatched && error is OperationCanceledException ? "cancelled" :
				!execution.Dispatched || failure.IsRejected ? "rejected" : "unknown";
			failed(execution, failure, status);
			var description = failure.SafeDescription ?? (status switch
			{
				"unknown" => "Outcome unknown: the broker may have applied this operation. It was not retried. Check this receipt and verify broker state before making another attempt.",
				"cancelled" => "Cancelled before dispatch.",
				_ => "Operation rejected. Check fields, entity state, size, permissions and transaction support. No automatic retry was made."
			});
			result = new(operationId, status, description, execution.MessageId);
		}
		receipts.Add(operationId, (fingerprint, result));
		return result;
	}
}
