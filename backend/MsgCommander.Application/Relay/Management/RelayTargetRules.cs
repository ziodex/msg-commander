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

public static class RelayTargetRules
{
	public static void Validate(this RelayTarget value)
	{
		value.Scope.Validate();
		if (value.PolicyName is not null)
		{
			AccessPolicyRules.ValidateName(value.PolicyName);
			if (!Regex.IsMatch(value.PolicyName, @"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$"))
				throw new OperationException(OperationFailure.InvalidInput, "Relay policy names must start and end with an alphanumeric character.");
		}
	}
}
