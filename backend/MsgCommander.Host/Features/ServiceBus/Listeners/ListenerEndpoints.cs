using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using static MsgCommander.Application.Common.DisplayValues;
using static MsgCommander.Application.ServiceBus.Messages.MessageProjection;

namespace MsgCommander.Host;

public sealed partial class ServiceBusWorkspace
{
	private Task<ListenerState> StartListener(JsonElement input, CancellationToken cancellation)
	{
		var request = new ListenerStart(input.GetProperty("id").GetString()!, Target(input),
			input.GetProperty("mode").GetString()!, input.GetProperty("sessionId").GetString()!,
			input.GetProperty("maxMessages").GetInt32(), input.GetProperty("maxSeconds").GetInt32(),
			input.GetProperty("maxLockSeconds").GetInt32(), Optional(input, "sessionMode") ?? "single",
			input.TryGetProperty("maxConcurrentSessions", out var concurrent) ? concurrent.GetInt32() : 1,
			input.TryGetProperty("sessionIdleSeconds", out var idle) ? idle.GetInt32() : 5);
		var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input.GetRawText())));
		return Context.StartListenerAsync(request, fingerprint, cancellation);
	}
}
