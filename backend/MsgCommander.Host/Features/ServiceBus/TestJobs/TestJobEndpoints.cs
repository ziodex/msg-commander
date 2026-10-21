using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MsgCommander.Application.ServiceBus.TestJobs;
using MsgCommander.Contracts.ServiceBus.TestJobs;
using MsgCommander.Domain.ServiceBus.TestJobs;

namespace MsgCommander.Host;

public sealed partial class ServiceBusWorkspace
{

	private async Task<TestJobResult> RunTestJob(JsonElement input, Func<object, Task> emit, CancellationToken cancellation)
	{
		if (input.EnumerateObject().Any(p => p.Name is not ("id" or "connectionId" or "target" or "mode" or "maxMessages" or "maxSeconds" or "delayMs" or "sessionId" or "body" or "contentType" or "acknowledged" or "workers" or "batchSize" or "generator" or "settlement" or "deadLetterReason" or "deadLetterDescription")))
			throw new OperationException(OperationFailure.InvalidInput, "Unsupported test job setting.");
		var target = Target(input);
		var request = new TestJobRequest(input.GetProperty("id").GetString()!, input.GetProperty("connectionId").GetString()!,
			new(target.Kind, target.Name, target.TopicName), input.GetProperty("mode").GetString()!,
			input.GetProperty("maxMessages").GetInt32(), input.GetProperty("maxSeconds").GetInt32(), input.GetProperty("delayMs").GetInt32(),
			input.TryGetProperty("workers", out var workers) ? workers.GetInt32() : 1,
			input.TryGetProperty("batchSize", out var batchSize) ? batchSize.GetInt32() : 1,
			input.GetProperty("sessionId").GetString()!, input.GetProperty("body").GetString()!, input.GetProperty("contentType").GetString()!,
			input.GetProperty("acknowledged").ValueKind == JsonValueKind.True, TestPayloads.Read(input),
			input.TryGetProperty("settlement", out var settlement) ? settlement.GetString()! : "complete",
			input.TryGetProperty("deadLetterReason", out var reason) ? reason.GetString()! : "",
			input.TryGetProperty("deadLetterDescription", out var description) ? description.GetString()! : "");
		var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input.GetRawText())));
		return await Context.RunTestAsync(request, fingerprint, progress => emit(progress), cancellation);
	}
}
