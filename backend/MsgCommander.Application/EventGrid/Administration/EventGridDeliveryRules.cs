using System.Text;
using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.EventGrid.Administration;

namespace MsgCommander.Application.EventGrid.Administration;

public static class EventGridDeliveryRules
{

	public static void Validate(this EventGridIdentity value, bool allowNone = true)
	{
		var (Type, UserAssignedIdentity) = value;
		if (Type is not ("None" or "SystemAssigned" or "UserAssigned") || !allowNone && Type == "None" || (Type == "UserAssigned" ? !EventGridDeliveryRules.Arm(UserAssignedIdentity, @"Microsoft.ManagedIdentity/userAssignedIdentities/[^/]+") : UserAssignedIdentity is not null))
			throw EventGridDeliveryRules.Bad("Choose a configured namespace managed identity.");
	}

	public static void Validate(this EventGridHeader value)
	{
		var (Name, Type, Value, IsSecret, SourceField) = value;
		if (Name is null || Name.Length is < 1 or > 64 || !Regex.IsMatch(Name, @"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$") || Regex.IsMatch(Name, @"^(aeg-|x-ms-|content-|host$|connection$|transfer-encoding$|cookie$|set-cookie$|accept$|user-agent$)", RegexOptions.IgnoreCase))
			throw EventGridDeliveryRules.Bad("Invalid or reserved delivery header name.");
		if (Type == "Static")
		{
			if (Value is null || Encoding.UTF8.GetByteCount(Value) > 4096 || Value.Any(char.IsControl) || IsSecret is null || SourceField is not null)
				throw EventGridDeliveryRules.Bad("Static header values require a secret choice and at most 4096 UTF-8 bytes without control characters.");
		}
		else if (Type == "Dynamic")
		{
			if (string.IsNullOrWhiteSpace(SourceField) || SourceField.Length > 1024 || SourceField.Any(char.IsControl) || Value is not null || IsSecret is not null)
				throw EventGridDeliveryRules.Bad("Dynamic headers require a JSON path only.");
		}
		else
			throw EventGridDeliveryRules.Bad("Choose a Static or Dynamic delivery header.");
	}

	public static void Validate(this EventGridDeadLetterChange value)
	{
		var (Action, ResourceId, ContainerName, Identity) = value;
		if (Action == "clear")
		{
			if (ResourceId is not null || ContainerName is not null || Identity is not null)
				throw EventGridDeliveryRules.Bad("Clear dead-lettering without replacement settings.");
			return;
		}
		if (Action != "set" || !EventGridDeliveryRules.Arm(ResourceId, @"Microsoft.Storage/storageAccounts/[a-z0-9]{3,24}") || ContainerName is null || !Regex.IsMatch(ContainerName, @"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$") || ContainerName.Contains("--") || Identity is null)
			throw EventGridDeliveryRules.Bad("Specify a storage account ARM ID, blob container name and managed identity.");
		Identity.Validate(false);
	}

	public static void Validate(this EventGridWebhookAuthentication value)
	{
		var (TenantId, ApplicationIdOrUri) = value;
		if (!Guid.TryParse(TenantId, out _) || string.IsNullOrEmpty(ApplicationIdOrUri) || ApplicationIdOrUri.Length > 1024 || ApplicationIdOrUri.Any(c => char.IsControl(c) || char.IsWhiteSpace(c)))
			throw EventGridDeliveryRules.Bad("Specify the webhook token audience (application ID/URI) and tenant UUID");
	}

	public static OperationException Bad(string message) => new(OperationFailure.InvalidInput, message + " No change was sent.");
	public static bool Arm(string? id, string suffix) => id is not null && id.Length <= 1024 && Regex.IsMatch(id, @"^/subscriptions/[0-9a-f-]{36}/resourceGroups/[^/]+/providers/" + suffix + "$", RegexOptions.IgnoreCase) && Guid.TryParse(id.Split('/')[2], out _) && !id.Split('/').Any(s => s is "." or ".." || s.Any(c => char.IsWhiteSpace(c) || char.IsControl(c) || c is '%' or '?' or '#'));
	public static void Validate(this EventGridDelivery value, string mode, EventGridDestination? destination, string action)
	{
		var (Identity, Headers, DeadLetter, WebhookAuthentication) = value;
		if (mode != "Push" && (Identity is not null || Headers is not null))
			throw Bad("Delivery identities and headers apply only to Push subscriptions.");
		Identity?.Validate();
		DeadLetter?.Validate();
		WebhookAuthentication?.Validate();
		if (WebhookAuthentication is not null && (mode != "Push" || Identity?.Type is not ("SystemAssigned" or "UserAssigned")))
			throw Bad("Webhook authentication requires an explicit managed delivery identity");
		if (Headers?.Count > 10 || Headers?.Any(h => h is null) == true || Headers?.Select(h => h.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() != Headers?.Count)
			throw Bad("Use up to 10 unique delivery headers.");
		foreach (var header in Headers ?? [])
			header.Validate();
	}
}
