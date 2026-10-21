using System.Text.RegularExpressions;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.ServiceBus.Entities;

public static class EntityName
{
	public static void Validate(EntityAddress address)
	{
		static bool Valid(string name, int maximum, bool paths) => name.Length <= maximum &&
			Regex.IsMatch(name, paths
				? @"^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$|^[A-Za-z0-9]$"
				: @"^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$|^[A-Za-z0-9]$") &&
			!name.Split('/').Any(segment => segment is "" or "." or "..");
		if (!Valid(address.Name, address.Kind == "subscription" ? 50 : 260, address.Kind != "subscription") ||
			address.Kind == "subscription" && !Valid(address.TopicName!, 260, true))
			throw new DomainRuleException("Use an entity name starting and ending with a letter or number; internal '.', '_', '-' and queue/topic path separators are supported. Subscription names are at most 50 characters.");
	}
}
