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

public static class RelaySettingsRules
{
	public static void Validate(this RelaySettings value, string kind)
	{
		if (value.UserMetadata is null || value.UserMetadata.Length > 1024 || (kind == "hybrid" && (value.RelayType is not null || value.RequiresTransportSecurity is not null)) || (kind == "wcf" && (value.RelayType is not ("Http" or "NetTcp") || value.RequiresTransportSecurity is null)))
			throw new OperationException(OperationFailure.InvalidInput, "Check Relay metadata, type and authorization settings.");
	}
}
