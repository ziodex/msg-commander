using MsgCommander.Application.Common;

namespace MsgCommander.Host.Transport;

public sealed record BackendProtocolError(int Code, string Message);
internal static class BackendProtocolErrors
{
	public static BackendProtocolError Describe(Exception failure, string? method) => failure switch
	{
		OperationCanceledException => new(-32800, "Operation cancelled."),
		OperationException error => new(OperationProtocolErrors.Code(error.Failure), error.Message),
		_ => new(-32602, "Operation failed. Check the connection settings and network."),
	};
}
