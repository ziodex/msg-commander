namespace MsgCommander.Contracts.Diagnostics;

public sealed record DiagnosticsResult(string Summary);
public sealed record DiagnosticsProgress(string OperationId, int Percent, string Message)
{
	public string Type => "progress";
}
