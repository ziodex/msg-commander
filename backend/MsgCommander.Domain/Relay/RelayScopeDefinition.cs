using System.Text.RegularExpressions;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.Relay;

public static class RelayScopeDefinition
{
	public static void Validate(string kind, string name)
	{
		if (kind == "namespace" && name == "")
			return;
		if (kind is not ("hybrid" or "wcf") || name is null || name.Length is < 1 or > 260 || !Regex.IsMatch(name, @"^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$") || name.Split('/').Any(part => part is "" or "." or ".."))
			throw new DomainRuleException("Select a namespace, Hybrid Connection or WCF Relay with a valid name.");
	}
}
