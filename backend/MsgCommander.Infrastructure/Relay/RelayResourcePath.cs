namespace MsgCommander.Infrastructure.Relay;

internal static class RelayResourcePath
{
	public static string For(RelayScope scope) => scope.Kind == "namespace" ? "" : $"/{(scope.Kind == "hybrid" ? "hybridConnections" : "wcfRelays")}/{Uri.EscapeDataString(scope.Name)}";
	public static string For(RelayTarget target) => For(target.Scope) + (target.PolicyName is null ? "" : "/authorizationRules/" + Uri.EscapeDataString(target.PolicyName));
}
