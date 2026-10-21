using MsgCommander.Application.Common;
using MsgCommander.Domain.NotificationHubs;

namespace MsgCommander.Application.NotificationHubs.Notifications;

public static class NotificationTagExpression
{
	public static void Validate(string expression) => DomainValidation.Check(() => NotificationTagFilter.Validate(expression));
	public static bool Matches(string expression, IReadOnlySet<string> tags) => DomainValidation.Read(() => NotificationTagFilter.Matches(expression, tags));
}
