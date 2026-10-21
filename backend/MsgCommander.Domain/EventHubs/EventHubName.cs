using System.Text.RegularExpressions;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.EventHubs;

public static class EventHubName
{
	public static string Validate(string? name, bool group = false)
	{
		if (group && name == "$Default")
			return name;
		if (string.IsNullOrEmpty(name) || name.Length > (group ? 50 : 256) || !Regex.IsMatch(name, @"^[A-Za-z0-9][A-Za-z0-9._-]*$"))
			throw new DomainRuleException("Enter a valid Event Hub or consumer group name.");
		return name;
	}
}
