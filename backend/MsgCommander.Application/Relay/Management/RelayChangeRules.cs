using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Application.AccessPolicies;
using MsgCommander.Application.Relay.Management;
using MsgCommander.Application.Relay.Hybrid;
using MsgCommander.Contracts.Relay.Management;
using MsgCommander.Contracts.Relay.Hybrid;
using MsgCommander.Contracts.Relay.Configuration;
using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.AccessPolicies;

namespace MsgCommander.Application.Relay.Management;

public static class RelayChangeRules
{
	public static void Validate(this RelayChange value)
	{
		value.Target.Validate();
		var edit = value.Action is "create" or "update";
		var policy = value.Target.PolicyName is not null;
		if (!Guid.TryParse(value.Id, out _) || !Guid.TryParse(value.ConnectionId, out _) || !value.Acknowledged || value.Action is not ("create" or "update" or "delete" or "regenerate") || (!policy && value.Target.Scope.Kind == "namespace") || (value.Action == "create") != (value.ExpectedRevision is null) || (value.ExpectedRevision is not null && !Regex.IsMatch(value.ExpectedRevision, "^[A-F0-9]{64}$")) || (edit && !policy) != (value.Settings is not null) || (edit && policy) != (value.Rights is not null) || (value.Action == "regenerate") != (value.KeyType is not null) || (value.Action == "regenerate" && !policy))
			throw new OperationException(OperationFailure.InvalidInput, "Review the selected Relay action and its settings before confirming.");
		value.Settings?.Validate(value.Target.Scope.Kind);
		if (value.Rights is not null)
			AccessPolicyRules.Rights(value.Rights);
		if (value.KeyType is not null)
			AccessPolicyRules.KeyType(value.KeyType);
	}
}
