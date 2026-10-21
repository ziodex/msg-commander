using MsgCommander.Contracts.ServiceBus.Authorization;

namespace MsgCommander.Application.ServiceBus.Authorization;

public static class AuthorizationRules
{
	public static string Path(string resourceId, AuthorizationTarget target, string name) => $"{resourceId}{(target.Kind == "namespace" ? "" : $"/{(target.Kind == "queue" ? "queues" : "topics")}/{target.Name}")}/authorizationRules/{name}";
	public static string Confirmation(string action, string resourceId, AuthorizationTarget target, string name, string? keyType) => $"{action.ToUpperInvariant()} {Path(resourceId, target, name)}{(action == "regenerate" ? $" {keyType}" : "")}";
}
