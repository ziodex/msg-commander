using MsgCommander.Application.Common;
using MsgCommander.Application.NotificationHubs.Registrations;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.NotificationHubs.Registrations;

namespace MsgCommander.Application.NotificationHubs.Connections;

public sealed record NotificationHubDataConnect(NotificationHubRegistrationsConnect Setup, ConnectionProfile Profile);
internal static class NotificationHubDataAuthentication
{
	public static void Validate(NotificationHubDataConnect request)
	{
		request.Setup.Validate();
		if (request.Profile.Id != request.Setup.ProfileId || request.Profile.Service != "notification-hubs")
			throw new OperationException(OperationFailure.InvalidInput, "Choose the matching Notification Hubs profile.");
	}

	public static Task<ConnectionProfile> CredentialAsync(NotificationHubDataConnect request, INotificationHubManagementAccess management, bool sending, CancellationToken cancellation)
	{
		var setup = request.Setup;
		if (setup.Source == "policy")
			return management.CredentialAsync(new(setup.ManagementConnectionId!, request.Profile, setup.Source, setup.PolicyTarget!, setup.KeyType!, sending), cancellation);
		if (request.Profile.Auth != "sas")
			throw new OperationException(OperationFailure.InvalidInput, sending ? "Use a saved SAS profile or explicitly select a Send or Manage policy." : "Use a SAS profile or explicitly select a Manage policy through the connected management workspace.");
		return Task.FromResult(request.Profile);
	}

	public static void Operation(string? id)
	{
		if (!Guid.TryParse(id, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid operation ID.");
	}
}
