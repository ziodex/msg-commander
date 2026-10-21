using System.Runtime.Serialization;
using System.Transactions;
using Azure;
using Azure.Messaging.ServiceBus;
using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Maintenance;

namespace MsgCommander.Infrastructure.ServiceBus.Messages;

public sealed class AzureMaintenanceFailureClassifier : IMaintenanceFailureClassifier
{
	public MaintenanceFailure Classify(Exception error, MaintenanceOperation operation)
	{
		var common = error is OperationException or UnauthorizedAccessException or ArgumentException;
		var lockLost = error is ServiceBusException { Reason: ServiceBusFailureReason.MessageLockLost or ServiceBusFailureReason.SessionLockLost };
		var entity = error is ServiceBusException { Reason: ServiceBusFailureReason.MessagingEntityNotFound or ServiceBusFailureReason.MessagingEntityDisabled };
		var request = error is RequestFailedException { Status: 400 or 401 or 403 or 404 };
		var rejected = common || (operation switch
		{
			MaintenanceOperation.Purge => request || lockLost || entity,
			MaintenanceOperation.ReceiveDelete => request || entity || error is ServiceBusException { Reason: ServiceBusFailureReason.SessionCannotBeLocked },
			_ => request || lockLost || entity || error is SerializationException ||
				error is RequestFailedException { Status: 409 or 412 } ||
				error is ServiceBusException { Reason: ServiceBusFailureReason.MessageSizeExceeded } ||
				operation == MaintenanceOperation.Resend && error is TransactionAbortedException
		});
		var detail = error is OperationException known ? known.Message : operation switch
		{
			MaintenanceOperation.Purge when error is UnauthorizedAccessException => "Access denied. Purge needs Listen rights and entity administration access.",
			MaintenanceOperation.Purge when lockLost => "A broker lock was lost. No automatic retry was made.",
			MaintenanceOperation.Resend when error is TransactionAbortedException => "The last transfer transaction rolled back; its original was not removed.",
			MaintenanceOperation.Resend when error is UnauthorizedAccessException => "Access denied. Resend needs Listen rights on the source, Send rights on the destination and administration access.",
			MaintenanceOperation.Resend when lockLost => "A source lock was lost. Resend stopped without retrying it.",
			_ => null
		};
		return new(rejected, error is ServiceBusException { Reason: ServiceBusFailureReason.ServiceTimeout }, detail);
	}
}
