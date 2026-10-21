using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Authorization;

namespace MsgCommander.Application.ServiceBus.Authorization;

public static class AuthorizationInputs
{
	public static void Validate(this AuthorizationContext context, string host)
	{
		var match = Regex.Match(context.ResourceId ?? "", @"^/subscriptions/([0-9a-f-]{36})/resourceGroups/[\w().-]{1,90}/providers/Microsoft\.ServiceBus/namespaces/([a-z0-9-]{6,50})$", RegexOptions.IgnoreCase);
		if (!match.Success || !Guid.TryParse(match.Groups[1].Value, out _) ||
			!string.Equals(match.Groups[2].Value + ".servicebus.windows.net", host, StringComparison.OrdinalIgnoreCase) ||
			!Guid.TryParse(context.ClientId, out _) || string.IsNullOrEmpty(context.TenantId) || context.TenantId.Length > 100 || !Regex.IsMatch(context.TenantId, @"^[A-Za-z0-9.-]+$"))
			throw new OperationException(OperationFailure.InvalidInput, "Enter a matching Azure Public Cloud namespace resource ID, tenant and public client application ID.");
	}
	public static void Validate(this AuthorizationTarget target)
	{
		if (target.Kind == "namespace" && target.Name is null)
			return;
		if (target.Kind is not ("queue" or "topic") || string.IsNullOrEmpty(target.Name))
			throw new OperationException(OperationFailure.InvalidInput, "SAS rules belong to a namespace, queue or topic.");
		EntityManagement.ValidateTarget(new(target.Kind, target.Name));
	}
}
