using System.Text.Json;
using MsgCommander.Application.AccessPolicies;
using MsgCommander.Application.EventHubs.Administration;
using MsgCommander.Application.ServiceBus.Authorization;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Application.ServiceBus.Rules;
using MsgCommander.Contracts.ResourceConfiguration;
using MsgCommander.Contracts.ServiceBus.Authorization;
using MsgCommander.Contracts.ServiceBus.Entities;

namespace MsgCommander.Application.ResourceConfiguration;

public static class ConfigurationTargets
{
	public static string Key(this MessagingConfigTarget target) => JsonSerializer.Serialize(new[] { target.Kind, target.Name.ToLowerInvariant(), target.ParentKind, target.ParentName?.ToLowerInvariant() });
	public static string Path(this MessagingConfigTarget target) => target.ParentKind is null ? target.Name : $"{target.ParentName}/{target.Kind}/{target.Name}";
	public static MessagingConfigTarget? Parent(this MessagingConfigTarget target) => target.ParentKind is null or "namespace" ? null : target.ParentKind == "subscription"
		? new("subscription", target.ParentName!.Split('/').Last(), "topic", target.ParentName[..target.ParentName.LastIndexOf("/Subscriptions/", StringComparison.Ordinal)])
		: new(target.ParentKind, target.ParentName!, null, null);
	public static EntityTarget Entity(this MessagingConfigTarget target) => target.Kind == "subscription" ? new(target.Kind, target.Name, target.ParentName) : target.Kind == "rule"
		? new("subscription", target.Parent()!.Name, target.Parent()!.ParentName) : new(target.Kind, target.Name);

	public static void Validate(this MessagingConfigTarget target, string service)
	{
		var (Kind, Name, ParentKind, ParentName) = target;
		if (service == "service-bus")
		{
			if (Kind is "queue" or "topic" && ParentKind is null && ParentName is null)
				EntityManagement.ValidateTarget(target.Entity());
			else if (Kind == "subscription" && ParentKind == "topic" && ParentName is not null)
				EntityManagement.ValidateTarget(target.Entity());
			else if (Kind == "rule" && ParentKind == "subscription" && ParentName is not null && ParentName.Contains("/Subscriptions/", StringComparison.Ordinal))
				SubscriptionRules.Target(target.Entity(), Name);
			else if (Kind == "policy" && ParentKind is "namespace" or "queue" or "topic" && ParentName is not null)
			{
				new AuthorizationTarget(ParentKind, ParentKind == "namespace" ? null : ParentName).Validate();
				AccessPolicyRules.ValidateName(Name);
				if (ParentKind == "namespace" && ParentName != "")
					throw MessagingConfiguration.Invalid();
			}
			else
				throw MessagingConfiguration.Invalid();
		}
		else if (service == "event-hubs")
		{
			if (Kind == "hub" && ParentKind is null && ParentName is null)
				EventHubNames.Validate(Name);
			else if (Kind == "group" && ParentKind == "hub" && ParentName is not null)
			{
				EventHubNames.Validate(ParentName);
				EventHubNames.Validate(Name, true);
			}
			else if (Kind == "policy" && ParentKind is "namespace" or "hub" && ParentName is not null)
			{
				if (ParentKind == "hub")
					EventHubNames.Validate(ParentName);
				else if (ParentName != "")
					throw MessagingConfiguration.Invalid();
				AccessPolicyRules.ValidateName(Name);
			}
			else
				throw MessagingConfiguration.Invalid();
		}
		else
			throw MessagingConfiguration.Invalid();
	}
}
