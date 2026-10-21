using System.Text.RegularExpressions;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.Relay;

public static class RelayManagementDefinition
{
	public static void Validate(string resourceId, string host, string tenantId, string clientId)
	{
		var match = Regex.Match(resourceId ?? "", @"^/subscriptions/([0-9a-f-]{36})/resourceGroups/[\w().-]{1,90}/providers/Microsoft\.Relay/namespaces/([a-z][a-z0-9-]{4,48}[a-z0-9])$", RegexOptions.IgnoreCase);
		if (!match.Success || !Guid.TryParse(match.Groups[1].Value, out _) || !string.Equals(match.Groups[2].Value + ".servicebus.windows.net", host, StringComparison.OrdinalIgnoreCase) || !Guid.TryParse(clientId, out _) || string.IsNullOrEmpty(tenantId) || tenantId.Length > 100 || !Regex.IsMatch(tenantId, @"^[A-Za-z0-9.-]+$"))
			throw new DomainRuleException("Enter a matching Relay namespace resource ID, Entra tenant and public client application ID.");
	}
}
