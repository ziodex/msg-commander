using System.Text.Json;

namespace MsgCommander.Host;

public sealed partial class ServiceBusWorkspace
{
	private Task<AuthorizationSession> ConnectAuthorization(JsonElement input, CancellationToken cancellation) =>
		Authorization.ConnectAsync(input.GetProperty("context").Deserialize<AuthorizationContext>(Json) ??
			throw new OperationException(OperationFailure.InvalidInput, "Missing management context."),
			Context.Prompts.ForwardAsync, cancellation);
	private static AuthorizationScope AuthorizationScope(JsonElement input) => new(input.GetProperty("authorizationId").GetString()!,
		input.GetProperty("target").Deserialize<AuthorizationTarget>(Json) ?? throw new OperationException(OperationFailure.InvalidInput, "Missing SAS rule scope."));
	private Task ChangeAuthorization(string action, JsonElement input, Action dispatching, CancellationToken cancellation) =>
		Authorization.ChangeAsync(new(AuthorizationScope(input), action, input.GetProperty("name").GetString()!,
			action is "create" or "update" ? input.GetProperty("rights").Deserialize<string[]>(Json) : null,
			Optional(input, "expectedRevision"), Optional(input, "keyType"), Optional(input, "confirmation")), dispatching, cancellation);
}
