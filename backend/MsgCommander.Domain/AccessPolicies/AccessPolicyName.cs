using System.Text.RegularExpressions;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.AccessPolicies;

public sealed record AccessPolicyName
{
	public string Value
	{
		get;
	}
	private AccessPolicyName(string value) => Value = value;

	public static AccessPolicyName Create(string? value)
	{
		if (value is null || value.Length is < 1 or > 50 || !Regex.IsMatch(value, @"^[A-Za-z0-9_][A-Za-z0-9._-]*$"))
			throw new DomainRuleException("SAS rule names use 1–50 letters, numbers, underscores, hyphens or periods and start with a letter, number or underscore.");
		return new(value);
	}
}
