using MsgCommander.Application.Common;
using MsgCommander.Contracts.Relay.Management;
using MsgCommander.Domain.Relay;

namespace MsgCommander.Application.Relay.Management;

public static class RelayScopeRules
{
	public static void Validate(this RelayScope value) => DomainValidation.Check(() => RelayScopeDefinition.Validate(value.Kind, value.Name));
}
