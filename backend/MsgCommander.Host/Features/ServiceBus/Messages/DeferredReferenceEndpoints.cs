using System.Text.Json;

namespace MsgCommander.Host;

public sealed partial class ServiceBusWorkspace
{
	private DeferredMessageScope DeferScope(EntityTarget target, string subQueue, string? sessionId) =>
		Context.DeferScope(target, subQueue, sessionId);
	private DeferredMessageScope DeferScope(JsonElement input) => DeferScope(Target(input), input.GetProperty("subQueue").GetString()!, input.GetProperty("sessionId").GetString());
	private DeferredReferences ListDeferred(JsonElement input) => owner.Deferred.List(DeferScope(input));
	private bool ForgetDeferred(JsonElement input) => owner.Deferred.Forget(DeferScope(input), input.GetProperty("sequenceNumber").GetString()!);
}
