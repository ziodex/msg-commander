using MsgCommander.Application.Common;
using MsgCommander.Contracts.Relay.Management;
using MsgCommander.Domain.Relay;

namespace MsgCommander.Application.Relay.Management;

public static class RelayManagementRules
{
	public static void Validate(this RelayManagement value, string host) => DomainValidation.Check(() => RelayManagementDefinition.Validate(value.ResourceId, host, value.TenantId, value.ClientId));
}
