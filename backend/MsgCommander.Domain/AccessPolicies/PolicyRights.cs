using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.AccessPolicies;

public sealed class PolicyRights
{
	public IReadOnlyList<string> Values
	{
		get;
	}
	private PolicyRights(string[] values) => Values = Array.AsReadOnly(values);

	public static PolicyRights Create(IReadOnlyList<string>? rights)
	{
		if (rights is null || rights.Count is < 1 or > 3 || rights.Distinct().Count() != rights.Count ||
			rights.Any(right => right is not ("Listen" or "Send" or "Manage")) ||
			rights.Contains("Manage") && (!rights.Contains("Listen") || !rights.Contains("Send")))
			throw new DomainRuleException("Choose unique Send/Listen rights. Manage requires both Send and Listen.");
		return new(rights.OrderBy(right => right, StringComparer.Ordinal).ToArray());
	}
}
