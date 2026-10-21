using MsgCommander.Application.Common;
using MsgCommander.Contracts.NotificationHubs.Registrations;
using MsgCommander.Domain.NotificationHubs;

namespace MsgCommander.Application.NotificationHubs.Registrations;

public static class NotificationHubRegistrationQueryRules
{
	public static void Validate(this NotificationHubRegistrationQuery value) => DomainValidation.Check(() => RegistrationQueryRules.Validate(value.Mode, value.Value, value.HandleKind, value.PageSize));
}
