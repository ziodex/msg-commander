using System.Text.RegularExpressions;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.NotificationHubs;

public sealed record NotificationHubAddress
{
	public string Kind
	{
		get;
	}
	public string Name
	{
		get;
	}
	public string? PolicyName
	{
		get;
	}
	private NotificationHubAddress(string kind, string name, string? policyName)
	{
		Kind = kind;
		Name = name;
		PolicyName = policyName;
	}
	public static NotificationHubAddress Create(string kind, string name, string? policyName = null)
	{
		if (!(kind == "namespace" && name == "") && (kind != "hub" || name is null || name.Length is < 1 or > 265 ||
			!Regex.IsMatch(name, @"^[A-Za-z][A-Za-z0-9-./_]*$") || name.Split('/').Any(part => part is "" or "." or "..")))
			throw new DomainRuleException("Select a Notification Hub with a valid name and non-empty path segments.");
		if (policyName is not null && (policyName is "." or ".." || policyName.Length is < 1 or > 256 || !Regex.IsMatch(policyName, @"^[A-Za-z0-9!()*._-]+$")))
			throw new DomainRuleException("Use a SAS policy name of 1–256 letters, numbers or !()*-._ characters.");
		return new(kind, name!, policyName);
	}
	public string Suffix => (Kind == "namespace" ? "" : "/notificationHubs/" + Uri.EscapeDataString(Name)) +
		(PolicyName is null ? "" : "/authorizationRules/" + Uri.EscapeDataString(PolicyName));
	public string Display => (Kind == "namespace" ? "namespace" : "hub/" + Name) + (PolicyName is null ? "" : "/policies/" + PolicyName);
}
