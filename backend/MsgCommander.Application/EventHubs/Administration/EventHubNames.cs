using MsgCommander.Application.Common;
using MsgCommander.Domain.EventHubs;

namespace MsgCommander.Application.EventHubs.Administration;

public static class EventHubNames
{
	public static string Validate(string? name, bool group = false) => DomainValidation.Read(() => EventHubName.Validate(name, group));
}
