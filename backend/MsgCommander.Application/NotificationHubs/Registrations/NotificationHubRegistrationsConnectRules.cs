using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.NotificationHubs.Management;
using MsgCommander.Contracts.NotificationHubs.Registrations;
using MsgCommander.Contracts.NotificationHubs.RegistrationFiles;
using MsgCommander.Contracts.NotificationHubs.Jobs;
using MsgCommander.Contracts.NotificationHubs.Notifications;
using MsgCommander.Contracts.Connections;
using MsgCommander.Application.AccessPolicies;
using MsgCommander.Application.NotificationHubs.Management;

namespace MsgCommander.Application.NotificationHubs.Registrations;

public static class NotificationHubRegistrationsConnectRules
{
	public static void Validate(this NotificationHubRegistrationsConnect value)
	{
		new NotificationHubScope("hub", value.HubName).Validate();
		value.PolicyTarget?.Validate();
		var policy = value.Source == "policy";
		if (!Guid.TryParse(value.Id, out _) || !Guid.TryParse(value.ProfileId, out _) || value.Source is not ("profile" or "policy") || policy != (value.ManagementConnectionId is not null) || policy != (value.PolicyTarget is not null) || policy != (value.KeyType is not null) || (policy && (!Guid.TryParse(value.ManagementConnectionId, out _) || value.PolicyTarget!.PolicyName is null || (value.PolicyTarget.Scope.Kind == "hub" && value.PolicyTarget.Scope.Name != value.HubName))))
			throw new OperationException(OperationFailure.InvalidInput, "Select a Manage policy on this hub or its namespace, or use the saved SAS profile.");
		if (value.KeyType is not null)
			AccessPolicyRules.KeyType(value.KeyType);
	}
}
