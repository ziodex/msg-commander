using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Application.EventHubs.Administration;
using MsgCommander.Contracts.EventHubs.Messaging;
using MsgCommander.Domain.Common;
using MsgCommander.Domain.EventHubs;

namespace MsgCommander.Application.EventHubs.Messaging;

public static class EventHubsValidation
{
	public static string Name(string? name, bool group = false) => EventHubNames.Validate(name, group);
	public static string Partition(string? value)
	{
		if (string.IsNullOrEmpty(value) || value.Length > 128 || !Regex.IsMatch(value, @"^[0-9]+$"))
			throw new OperationException(OperationFailure.InvalidInput, "Enter a partition ID.");
		return value;
	}

	public static StreamPosition Position(EventPositionSpec spec)
	{
		try
		{
			return StreamPosition.Create(spec.Kind, spec.Value, spec.Inclusive);
		}
		catch (DomainRuleException error) { throw new OperationException(OperationFailure.InvalidInput, error.Message); }
	}
}
public static class EventHubsManagementRules
{
	public static void Validate(this EventHubsManagementContext context, string host)
	{
		var match = Regex.Match(context.ResourceId ?? "", @"^/subscriptions/([0-9a-f-]{36})/resourceGroups/[\w().-]{1,90}/providers/Microsoft\.EventHub/namespaces/([a-z0-9-]{6,50})$", RegexOptions.IgnoreCase);
		if (!match.Success || !Guid.TryParse(match.Groups[1].Value, out _) || !Guid.TryParse(context.ClientId, out _) ||
			!string.Equals(match.Groups[2].Value + ".servicebus.windows.net", host, StringComparison.OrdinalIgnoreCase) ||
			string.IsNullOrEmpty(context.TenantId) || context.TenantId.Length > 100 || !Regex.IsMatch(context.TenantId, @"^[A-Za-z0-9.-]+$"))
			throw new OperationException(OperationFailure.InvalidInput, "Enter a matching Event Hubs namespace resource ID, tenant and public client application ID for Azure Public Cloud.");
	}
}
