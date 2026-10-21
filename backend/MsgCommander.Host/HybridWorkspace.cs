using System.Text.Json;

namespace MsgCommander.Host;

public sealed class HybridWorkspace(IHybridGatewayFactory factory) : IAsyncDisposable
{
	private readonly HybridJobService jobs = new(factory);
	public async Task<object?> ExecuteAsync(string method, JsonElement input, Func<object, Task> emit, CancellationToken cancellation)
	{
		if (method == "hybrid.reset")
		{
			await jobs.ResetAsync();
			return null;
		}

		if (method == "hybrid.result")
			return jobs.GetResult(input.GetProperty("profileId").GetString(), input.GetProperty("operationId").GetString());
		if (method != "hybrid.run")
			throw new OperationException(OperationFailure.UnknownOperation, "Unknown Hybrid Connection method.");
		var request = RelayRequests.Read<HybridRun>(input.GetProperty("request")) ?? throw HybridRunRules.Invalid();
		var profile = RelayRequests.Profile(input) ?? throw HybridRunRules.Invalid();
		return await jobs.RunAsync(request, profile, progress => emit(progress), code => emit(new { type = "device-code", operationId = request.Id, code = code.Code, expiresOn = code.ExpiresOn }), cancellation);
	}

	public ValueTask DisposeAsync() => jobs.DisposeAsync();
}
