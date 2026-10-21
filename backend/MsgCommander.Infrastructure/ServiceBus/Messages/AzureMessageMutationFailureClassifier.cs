using System.Transactions;
using Azure.Messaging.ServiceBus;
using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Messages;

namespace MsgCommander.Infrastructure.ServiceBus.Messages;

public sealed class AzureMessageMutationFailureClassifier : IMessageMutationFailureClassifier
{
	public MutationFailure Classify(Exception error, MutationScope scope)
	{
		// Administration APIs wrap HTTP rejections in several SDK exception types.
		if (scope != MutationScope.Messaging && error.InnerException is Azure.RequestFailedException managementError)
			error = managementError;
		var lockLost = error is ServiceBusException { Reason: ServiceBusFailureReason.MessageLockLost or ServiceBusFailureReason.SessionLockLost };
		var rejected = error is OperationException or UnauthorizedAccessException or ArgumentException or System.Runtime.Serialization.SerializationException or TransactionAbortedException ||
			error is Azure.RequestFailedException { Status: 400 or 401 or 403 or 404 or 409 or 412 } ||
			error is ServiceBusException { Reason: ServiceBusFailureReason.MessageSizeExceeded or ServiceBusFailureReason.MessagingEntityNotFound or ServiceBusFailureReason.MessagingEntityDisabled } || lockLost;
		var summary = error switch
		{
			OperationException known => known.Message,
			Azure.RequestFailedException { Status: 401 or 403 } when scope == MutationScope.Authorization => "SAS rule management was denied. Entra needs Azure Resource Manager authorization-rule permissions; messaging SAS rights are not sufficient.",
			Azure.RequestFailedException { Status: 400 or 409 or 412 } when scope == MutationScope.Authorization => "Azure rejected this SAS rule change. Refresh the rule and check rights, policy limits and protected system rules.",
			Azure.RequestFailedException { Status: 401 or 403 } => "Entity management was denied or restricted by the tier/quota. Check namespace SAS Manage rights, Entra administration permissions and namespace limits.",
			Azure.RequestFailedException { Status: 400 } when scope == MutationScope.Rule => "The broker rejected this rule. Check SQL filter/action syntax, typed parameters, namespace tier and rule limits.",
			Azure.RequestFailedException { Status: 404 } when scope == MutationScope.Rule => "The rule or its parent subscription no longer exists. Refresh the rules and entity list.",
			Azure.RequestFailedException { Status: 409 } => "The entity already exists or the broker reported a conflict. Refresh its settings before another attempt.",
			Azure.RequestFailedException { Status: 404 } => "The entity or parent topic no longer exists. Refresh the entity list.",
			Azure.RequestFailedException { Status: 412 } => "Entity settings changed. Reload the form and review your changes.",
			Azure.RequestFailedException { Status: 400 } => "The broker rejected these entity settings. Check tier limits, forwarding destinations and incompatible options.",
			UnauthorizedAccessException when scope != MutationScope.Messaging => "Entity management was denied. Use namespace SAS Manage rights or an Entra role with entity administration permissions.",
			UnauthorizedAccessException => "Access denied. Sending needs Send rights; receiving and settlement need Listen rights.",
			ServiceBusException { Reason: ServiceBusFailureReason.MessageSizeExceeded } => "Broker rejected the message size or property encoding. Source was not completed.",
			ServiceBusException { Reason: ServiceBusFailureReason.MessageLockLost or ServiceBusFailureReason.SessionLockLost } => "The broker lock was lost. Receive again before attempting another settlement.",
			ServiceBusException broker => ServiceBusFailures.Describe(broker),
			TransactionAbortedException => "Replay transaction rolled back. Refresh the source lock before another attempt.",
			_ => null
		};

		return new(rejected, lockLost, error is ServiceBusException { Reason: ServiceBusFailureReason.SessionLockLost }, summary);
	}
}
