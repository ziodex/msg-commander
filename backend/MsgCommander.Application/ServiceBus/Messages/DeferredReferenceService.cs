using System.Globalization;
using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Messages;
using MsgCommander.Contracts.ServiceBus.Sessions;
using MsgCommander.Domain.ServiceBus.Messages;
using static MsgCommander.Application.Common.DisplayValues;
using static MsgCommander.Application.ServiceBus.Messages.MessageProjection;

namespace MsgCommander.Application.ServiceBus.Messages;

public sealed class DeferredReferenceService(IMessageDeferProvider deferProvider)
{
	private static void Validate(DeferredMessageScope scope)
	{
		scope.Target.Validate(peek: true);
		if (scope.SubQueue is not ("active" or "dead-letter" or "transfer-dead-letter"))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid message subqueue.");
		if (scope.SessionId.Length > 128 || (scope.SubQueue != "active" && scope.SessionId.Length > 0))
			throw new OperationException(OperationFailure.InvalidInput, "Use the exact session ID for main-queue references; dead-letter references have no session filter.");
	}
	public DeferredReferences List(DeferredMessageScope scope)
	{
		Validate(scope);
		IReadOnlyList<DeferredMessageReference> entries;
		try
		{
			entries = deferProvider.List(scope);
		}
		catch { throw new OperationException(OperationFailure.OperationBlocked, "Deferred references could not be read. Manual sequence retrieval remains available."); }
		return new(entries.Count, entries.Take(100).Select(entry => new DeferredReferenceInfo(entry.Sequence.ToString(CultureInfo.InvariantCulture), MsgCommander.Application.Common.DisplayValues.Timestamp(entry.RecordedAt))).ToArray());
	}
	public bool Forget(DeferredMessageScope scope, string sequenceNumber)
	{
		Validate(scope);
		if (!long.TryParse(sequenceNumber, NumberStyles.None, CultureInfo.InvariantCulture, out var sequence) || sequence < 0)
			throw new OperationException(OperationFailure.InvalidInput, "Use an exact nonnegative Int64 sequence number.");
		try
		{
			return deferProvider.Forget(scope, sequence);
		}
		catch { throw new OperationException(OperationFailure.OperationBlocked, "The local reference could not be forgotten. No broker operation was sent."); }
	}
	public string? Record(DeferredMessageScope scope, long sequence)
	{
		try
		{
			deferProvider.Remember(scope, new(sequence, DateTimeOffset.UtcNow));
			return null;
		}
		catch { return $"Message deferred, but its local reference could not be recorded. Retain sequence {sequence.ToString(CultureInfo.InvariantCulture)} for manual retrieval."; }
	}
	public string? Acknowledge(DeferredMessageScope scope, long sequence)
	{
		try
		{
			deferProvider.Forget(scope, sequence);
			return null;
		}
		catch { return "Message received and locked, but its local deferred reference could not be removed. Review held messages before receiving again."; }
	}
}
