using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Application.AccessPolicies;
using MsgCommander.Contracts.NotificationHubs.Management;
using MsgCommander.Domain.Common;
using MsgCommander.Domain.NotificationHubs;

namespace MsgCommander.Application.NotificationHubs.Management;

public static class NotificationHubRules
{
	public static void Validate(this NotificationHubManagement value, string host)
	{
		var match = Regex.Match(value.ResourceId ?? "", @"^/subscriptions/([0-9a-f-]{36})/resourceGroups/[\w().-]{1,90}/providers/Microsoft\.NotificationHubs/namespaces/([a-z][a-z0-9-]{0,49})$", RegexOptions.IgnoreCase);
		if (!match.Success || value.ResourceId!.Split('/')[4] is "." or ".." || !Guid.TryParse(match.Groups[1].Value, out _) ||
			!string.Equals(match.Groups[2].Value + ".servicebus.windows.net", host, StringComparison.OrdinalIgnoreCase) || !Guid.TryParse(value.ClientId, out _) ||
			string.IsNullOrEmpty(value.TenantId) || value.TenantId.Length > 100 || !Regex.IsMatch(value.TenantId, @"^[A-Za-z0-9.-]+$"))
			throw new OperationException(OperationFailure.InvalidInput, "Enter a matching Notification Hubs namespace resource ID, Entra tenant and public client application ID.");
	}
	private static NotificationHubAddress Address(NotificationHubScope scope, string? policy = null)
	{
		try
		{
			return NotificationHubAddress.Create(scope.Kind, scope.Name, policy);
		}
		catch (DomainRuleException error) { throw new OperationException(OperationFailure.InvalidInput, error.Message); }
	}
	public static void Validate(this NotificationHubScope scope) => Address(scope);
	public static void Validate(this NotificationHubTarget target) => Address(target.Scope, target.PolicyName);
	public static string Suffix(this NotificationHubScope scope) => Address(scope).Suffix;
	public static string Suffix(this NotificationHubTarget target) => Address(target.Scope, target.PolicyName).Suffix;
	public static string Display(this NotificationHubTarget target) => Address(target.Scope, target.PolicyName).Display;
	public static void Validate(this NotificationHubSettings value)
	{
		try
		{
			NotificationHubSettingsRules.Validate(value.RegistrationTtl, value.Tags?.Select(tag => new KeyValuePair<string, string>(tag?.Name!, tag?.Value!)).ToArray());
		}
		catch (DomainRuleException error) { throw new OperationException(OperationFailure.InvalidInput, error.Message); }
	}
	public static void Validate(this NotificationHubChange value)
	{
		value.Target.Validate();
		var edit = value.Action is "create" or "update";
		var policy = value.Target.PolicyName is not null;
		if (!Guid.TryParse(value.Id, out _) || !Guid.TryParse(value.ConnectionId, out _) || !value.Acknowledged || value.Action is not ("create" or "update" or "delete" or "regenerate") ||
			!policy && value.Target.Scope.Kind == "namespace" || (value.Action == "create") != (value.ExpectedRevision is null) ||
			value.ExpectedRevision is not null && !Regex.IsMatch(value.ExpectedRevision, "^[A-F0-9]{64}$") ||
			(edit && !policy) != (value.Settings is not null) || (edit && policy) != (value.Rights is not null) || (value.Action == "regenerate") != (value.KeyType is not null) || value.Action == "regenerate" && !policy)
			throw new OperationException(OperationFailure.InvalidInput, "Review the selected Notification Hubs action and settings before confirming.");
		value.Settings?.Validate();
		if (value.Rights is not null)
			AccessPolicyRules.Rights(value.Rights);
		if (value.KeyType is not null)
			AccessPolicyRules.KeyType(value.KeyType);
	}
}
