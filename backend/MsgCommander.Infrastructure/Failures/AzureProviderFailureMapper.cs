using Azure.Identity;
using Azure.Messaging.ServiceBus;
using MsgCommander.Application.Common;
using MsgCommander.Infrastructure.ServiceBus;

namespace MsgCommander.Infrastructure.Failures;

public sealed class AzureProviderFailureMapper : IProviderFailureMapper
{
	public OperationException? Map(Exception failure, string? method) => failure switch
	{
		AuthenticationFailedException => new(OperationFailure.AuthenticationRequired, "Sign-in failed. Check the tenant, public client application and account permissions."),
		Azure.RequestFailedException error when method?.StartsWith("eg.", StringComparison.Ordinal) == true && error.Status is 401 or 403 => new(OperationFailure.AuthenticationRequired, "Event Grid resource discovery requires Entra ARM read permission on this namespace, its topics and event subscriptions. Check the tenant and assigned role."),
		Azure.RequestFailedException error when method?.StartsWith("nh.", StringComparison.Ordinal) == true && error.Status is 401 or 403 => new(OperationFailure.AuthenticationRequired, "Notification Hubs management access denied. Check Microsoft Entra resource read/write/delete, listKeys and regenerateKeys permissions. SAS data access is separate."),
		Azure.RequestFailedException error when method?.StartsWith("relay.", StringComparison.Ordinal) == true && error.Status is 401 or 403 => new(OperationFailure.AuthenticationRequired, "Relay management access denied. Check Microsoft Entra resource read/write, listKeys and regenerateKeys permissions. SAS data access is separate."),
		Azure.RequestFailedException error when method?.StartsWith("eh.", StringComparison.Ordinal) == true && error.Status is 401 or 403 => new(OperationFailure.AuthenticationRequired, "Event Hubs management access was denied. Namespace browsing needs an Entra identity with ARM read permission; SAS data access is separate."),
		Azure.Messaging.EventHubs.EventHubsException => new(OperationFailure.TransportUnavailable, "Event Hubs request failed. Check the hub/partition, Listen/Data Receiver for reading or Send/Data Sender for publishing, and AMQP WebSockets connectivity. No operation was retried."),
		UnauthorizedAccessException when method?.StartsWith("eh.", StringComparison.Ordinal) == true => new(OperationFailure.AuthenticationRequired, "Event Hubs access denied. Check Listen/Data Receiver for reading, Send/Data Sender for publishing and ARM read permission for browsing."),
		Azure.RequestFailedException error when method?.StartsWith("sb.authorization.", StringComparison.Ordinal) == true && error.Status is 401 or 403 => new(OperationFailure.AuthenticationRequired, "Azure Resource Manager denied this SAS policy request. Check Entra authorization-rule, listKeys and regenerateKeys permissions for this resource."),
		Azure.RequestFailedException error when error.Status == 404 => new(OperationFailure.ResourceNotFound, "The namespace or entity no longer exists. Refresh the resource list."),
		Azure.RequestFailedException error when error.Status is 401 or 403 => new(OperationFailure.AuthenticationRequired, "Management access was denied. Check namespace-level SAS Manage rights or your Entra Service Bus role."),
		Azure.RequestFailedException => new(OperationFailure.TransportUnavailable, "Azure management request failed. Check connectivity, permissions and throttling, then retry explicitly."),
		ServiceBusException error when error.Reason == ServiceBusFailureReason.MessagingEntityNotFound => new(OperationFailure.ResourceNotFound, "The entity no longer exists. Refresh the resource list."),
		ServiceBusException error when error.Reason == ServiceBusFailureReason.SessionCannotBeLocked => new(OperationFailure.SessionLockUnavailable, "This session is locked by another receiver or cannot be accepted. No messages were received. Try again explicitly later."),
		ServiceBusException error when error.Reason == ServiceBusFailureReason.SessionLockLost => new(OperationFailure.SessionLockUnavailable, "The session lock was lost. Refresh held messages, release this receiver and accept the session again."),
		NotSupportedException => new(OperationFailure.UnsupportedOperation, "The endpoint does not support this operation. Session listing is not emulated by receiving messages."),
		ServiceBusException error when error.Reason == ServiceBusFailureReason.MessageNotFound => new(OperationFailure.DeferredMessageUnavailable, "No available deferred message matches that sequence in the selected entity/session/subqueue."),
		UnauthorizedAccessException when method?.StartsWith("sb.session", StringComparison.Ordinal) == true => new(OperationFailure.AuthenticationRequired, "Session access was denied. Check Listen rights or an Entra Service Bus data receiver role."),
		UnauthorizedAccessException => new(OperationFailure.AuthenticationRequired, "Message access was denied. Peeking requires Listen rights or an Entra Service Bus data receiver role."),
		ServiceBusException error => new(OperationFailure.TransportUnavailable, ServiceBusFailures.Describe(error) + " After interrupted receives, refresh held messages or reconnect."),
		_ => null,
	};
}
