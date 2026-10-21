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

namespace MsgCommander.Application.NotificationHubs.Notifications;

public static class NotificationTestSendRules
{
	public static void Validate(this NotificationTestSend value)
	{
		if (!Guid.TryParse(value.Id, out _) || !Guid.TryParse(value.ConnectionId, out _) || !value.Acknowledge || value.Draft is null)
			throw new OperationException(OperationFailure.InvalidInput, "Acknowledge that this test sends real notifications to devices.");
		value.Draft.Validate();
	}
}
