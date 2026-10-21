using System.Text.Json;
using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Application.AccessPolicies;
using MsgCommander.Contracts.EventHubs.Administration;

namespace MsgCommander.Application.EventHubs.Administration;

public static class EventAdministrationInputs
{
	public static void Validate(this EventAdminTarget target)
	{
		var (Kind, Name, HubName) = target;
		if (Kind == "hub" && HubName is null)
			EventHubNames.Validate(Name);
		else if (Kind == "group" && !string.IsNullOrEmpty(HubName))
		{
			EventHubNames.Validate(HubName);
			EventHubNames.Validate(Name, true);
		}
		else if (Kind == "policy" && HubName is not null)
		{
			if (HubName.Length > 0)
				EventHubNames.Validate(HubName);
			AccessPolicyRules.ValidateName(Name);
		}
		else
			throw new OperationException(OperationFailure.InvalidInput, "Choose a hub, consumer group or namespace/hub SAS policy.");
	}

	public static string Path(this EventAdminTarget target) => target.Kind == "hub" ? target.Name : target.Kind == "group" ? $"{target.HubName}/consumerGroups/{target.Name}" : $"{(target.HubName == "" ? "namespace" : target.HubName)}/authorizationRules/{target.Name}";
	public static string Confirmation(this EventAdminTarget target, string action, string? key) => $"{action.ToUpperInvariant()} {target.Path()}{(action == "regenerate" ? $" {key}" : "")}";


	public static void Validate(this EventHubSettings settings)
	{
		var Capture = settings.Capture;
		EventHubAdministrationRules.Definition(settings);
		if (Capture.ValueKind != JsonValueKind.Object)
			throw new OperationException(OperationFailure.InvalidInput, "Choose how to handle Capture.");
		var mode = Capture.GetProperty("mode").GetString();
		var names = Capture.EnumerateObject().Select(p => p.Name).Order().ToArray();
		if (mode is "preserve" or "disabled" && names.SequenceEqual(["mode"]))
			return;
		if (mode != "configure" || !names.SequenceEqual(new[] { "mode", "intervalSeconds", "sizeBytes", "skipEmpty", "storageAccountResourceId", "blobContainer", "archiveNameFormat", "identity", "userAssignedIdentity" }.Order()))
			throw new OperationException(OperationFailure.InvalidInput, "Use the explicit Capture configuration fields.");
		var seconds = Capture.GetProperty("intervalSeconds").GetInt32();
		var bytes = Capture.GetProperty("sizeBytes").GetInt32();
		var storage = Capture.GetProperty("storageAccountResourceId").GetString() ?? "";
		var container = Capture.GetProperty("blobContainer").GetString() ?? "";
		var archive = Capture.GetProperty("archiveNameFormat").GetString() ?? "";
		var identity = Capture.GetProperty("identity").GetString();
		var identityId = Capture.GetProperty("userAssignedIdentity").GetString() ?? "";
		if (seconds is < 60 or > 900 || bytes is < 10485760 or > 524288000 || Capture.GetProperty("skipEmpty").ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
			storage.Length > 1024 || !Regex.IsMatch(storage, @"^/subscriptions/[0-9a-f-]{36}/resourceGroups/[\w().-]{1,90}/providers/Microsoft.Storage/storageAccounts/[a-z0-9]{3,24}$", RegexOptions.IgnoreCase) ||
			container.Length is < 3 or > 63 || !Regex.IsMatch(container, @"^[a-z0-9]+(?:-[a-z0-9]+)*$") || archive.Length > 1024 ||
			new[] { "Namespace", "EventHub", "PartitionId", "Year", "Month", "Day", "Hour", "Minute", "Second" }.Any(p => !archive.Contains("{" + p + "}")) ||
			identity is not ("none" or "SystemAssigned" or "UserAssigned") || (identity == "UserAssigned" ? identityId.Length > 1024 || !Regex.IsMatch(identityId, @"^/subscriptions/[0-9a-f-]{36}/resourceGroups/[\w().-]{1,90}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/[A-Za-z0-9_-]{1,128}$", RegexOptions.IgnoreCase) : identityId.Length > 0))
			throw new OperationException(OperationFailure.InvalidInput, "Check Capture size/time bounds, storage resource, container, archive placeholders and managed identity.");
	}


	public static void Validate(this EventAdminChange change)
	{
		var (Id, ConnectionId, Target, Action, ExpectedRevision, Settings, UserMetadata, Rights, KeyType, Acknowledged, Confirmation) = change;
		Target.Validate();
		var edit = Action is "create" or "update";
		if (!Guid.TryParse(Id, out _) || Action is not ("create" or "update" or "delete" or "regenerate") || !Acknowledged || Confirmation is null || Confirmation.Length > 1024 ||
			(Action == "create" ? ExpectedRevision is not null : ExpectedRevision is null || !Regex.IsMatch(ExpectedRevision, "^[A-F0-9]{64}$")) ||
			((edit && Target.Kind == "hub") != (Settings is not null)) || ((edit && Target.Kind == "group") != (UserMetadata is not null)) ||
			((edit && Target.Kind == "policy") != (Rights is not null)) || ((Action == "regenerate") != (KeyType is not null)) || (Action == "regenerate" && Target.Kind != "policy") || UserMetadata?.Length > 1024)
			throw new OperationException(OperationFailure.InvalidInput, "Review the action and supply only its applicable settings, revision and acknowledgement.");
		if (Action is "delete" or "regenerate" && Confirmation != Target.Confirmation(Action, KeyType))
			throw new OperationException(OperationFailure.InvalidInput, "Type the confirmation shown for this resource and key slot.");
		if (Target.Kind == "group" && Target.Name == "$Default" && Action is "create" or "delete")
			throw new OperationException(OperationFailure.InvalidInput, "The built-in $Default consumer group cannot be created or deleted here.");
		Settings?.Validate();
		if (Rights is not null)
			AccessPolicyRules.Rights(Rights);
		if (KeyType is not null)
			AccessPolicyRules.KeyType(KeyType);
	}
}
