using MsgCommander.Application.Common;

namespace MsgCommander.Host.Transport;

public static class OperationProtocolErrors
{
	public static int Code(OperationFailure failure) => failure switch
	{
		OperationFailure.InvalidInput => -32602,
		OperationFailure.UnknownOperation => -32601,
		OperationFailure.UnsupportedProtocol => -32000,
		OperationFailure.AuthenticationRequired => -32001,
		OperationFailure.ConcurrencyLimit => -32002,
		OperationFailure.TransportUnavailable => -32003,
		OperationFailure.ResourceNotFound => -32004,
		OperationFailure.ConnectionExpired => -32010,
		OperationFailure.InspectionLimit => -32011,
		OperationFailure.InvalidBrokerSequence => -32012,
		OperationFailure.SnapshotExpired => -32013,
		OperationFailure.OperationBlocked => -32020,
		OperationFailure.DeliveryExpired => -32021,
		OperationFailure.DeferredMessageUnavailable => -32022,
		OperationFailure.RevisionConflict => -32030,
		OperationFailure.ReceiverInUse => -32031,
		OperationFailure.SessionCursorInvalid => -32040,
		OperationFailure.SessionLeaseExpired => -32041,
		OperationFailure.SessionLockUnavailable => -32042,
		OperationFailure.SessionStateConflict => -32043,
		OperationFailure.UnsupportedOperation => -32044,
		OperationFailure.ReceiverContractViolation => -32050,
		_ => throw new ArgumentOutOfRangeException(nameof(failure)),
	};
}
