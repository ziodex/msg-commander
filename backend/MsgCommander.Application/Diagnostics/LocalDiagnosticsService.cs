using MsgCommander.Application.Common;
using MsgCommander.Contracts.Diagnostics;

namespace MsgCommander.Application.Diagnostics;

public static class LocalDiagnosticsService
{
	public static async Task<DiagnosticsResult> RunAsync(string operationId, int durationMs, Func<DiagnosticsProgress, Task> emit, CancellationToken cancellation)
	{
		if (!Guid.TryParse(operationId, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid operation ID.");
		if (durationMs is < 0 or > 10000)
			throw new OperationException(OperationFailure.InvalidInput, "Invalid diagnostics duration.");
		for (var index = 1; index <= 5; index++)
		{
			await Task.Delay(durationMs / 5, cancellation);
			await emit(new(operationId, index * 20, "Checking the private process connection…"));
		}

		return new("Local runtime, framed IPC and progress delivery passed. No Azure request was made.");
	}
}
