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

namespace MsgCommander.Application.NotificationHubs.Jobs;

public static class NotificationHubJobSubmitRules
{
	public static void Validate(this NotificationHubJobSubmit value)
	{
		if (!Guid.TryParse(value.ReviewId, out _) || !value.Acknowledge)
			throw new OperationException(OperationFailure.InvalidInput, "Review and acknowledge this bulk job before submitting.");
	}
}
