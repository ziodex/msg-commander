namespace MsgCommander.Application.Common;

public enum OperationFailure
{
	InvalidInput,
	UnknownOperation,
	UnsupportedProtocol,
	AuthenticationRequired,
	ResourceNotFound,
	ConcurrencyLimit,
	TransportUnavailable,
	ConnectionExpired,
	InspectionLimit,
	InvalidBrokerSequence,
	SnapshotExpired,
	OperationBlocked,
	DeliveryExpired,
	DeferredMessageUnavailable,
	RevisionConflict,
	ReceiverInUse,
	SessionCursorInvalid,
	SessionLeaseExpired,
	SessionLockUnavailable,
	SessionStateConflict,
	UnsupportedOperation,
	ReceiverContractViolation,
}

/// <summary>A safe application rejection; transports choose their own representation.</summary>
public sealed class OperationException(OperationFailure failure, string message) : Exception(message)
{
	public OperationFailure Failure { get; } = failure;
}
