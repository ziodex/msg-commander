using System.Security.Cryptography;
using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.AccessPolicies;
using MsgCommander.Domain.AccessPolicies;

namespace MsgCommander.Application.AccessPolicies;

public static class AccessPolicyRules
{
	public static void ValidateName(string name) => DomainValidation.Read(() => AccessPolicyName.Create(name));
	public static string[] Rights(IReadOnlyList<string>? rights) => DomainValidation.Read(() => PolicyRights.Create(rights)).Values.ToArray();
	public static void KeyType(string? type)
	{
		if (type is not ("PrimaryKey" or "SecondaryKey"))
			throw new OperationException(OperationFailure.InvalidInput, "Select exactly one key slot to reveal or regenerate.");
	}
	public static AuthorizationRule Project(string scope, string name, IReadOnlyList<string> rights)
	{
		ValidateName(name);
		var sorted = Rights(rights);
		return new(name, sorted, Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
		{
			scope,
			name,
			rights = sorted
		}))));
	}
}
