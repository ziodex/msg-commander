using System.Text.Json;
using MsgCommander.Application.ServiceBus.Sessions;

namespace MsgCommander.Host;

public sealed partial class ServiceBusWorkspace
{
	private Task<Deliveries> Receive(JsonElement input, CancellationToken cancellation) =>
		Interactive.ReceiveAsync(new(Target(input), input.GetProperty("subQueue").GetString()!,
			input.GetProperty("sessionId").GetString()!, input.GetProperty("maxMessages").GetInt32(), input.GetProperty("waitSeconds").GetInt32(),
			input.TryGetProperty("deferredSequence", out var deferred) ? deferred.GetString() ??
				throw new OperationException(OperationFailure.InvalidInput, "Use a nonnegative Int64 deferred sequence number.") : null,
			Optional(input, "sessionLeaseId")), cancellation);
	private Task<PeekPage> Peek(JsonElement input, CancellationToken cancellation, bool scheduled = false) =>
		Inspection.PeekAsync(new(Target(input), scheduled ? "active" : input.GetProperty("subQueue").GetString()!,
			input.GetProperty("fromSequenceNumber").GetString()!, input.GetProperty("maxMessages").GetInt32(), scheduled), cancellation);
}
