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

public static class NotificationHubRegistrationChangeRules
{
	public static void Validate(this NotificationHubRegistrationChange value)
	{
		if (!Guid.TryParse(value.Id, out _) || !Guid.TryParse(value.ConnectionId, out _) || !value.Acknowledge || value.Action is not ("create" or "update" or "delete") || (value.Action == "create" ? value.SnapshotId is not null : !Guid.TryParse(value.SnapshotId, out _)) || (value.Action == "delete") != (value.Draft is null))
			throw new OperationException(OperationFailure.InvalidInput, "Review and acknowledge the registration change; edit/delete requires a current snapshot.");
	}
}
