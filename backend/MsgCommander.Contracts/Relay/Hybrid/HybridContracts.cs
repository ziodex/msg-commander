using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.Relay.Management;

namespace MsgCommander.Contracts.Relay.Hybrid;

public sealed record HybridHeader(string Name, string Value);
public sealed record HybridRun(string Id, string ProfileId, string Name, string Mode, string Method, string Body, string Encoding, IReadOnlyList<HybridHeader> Headers, int ResponseStatus, int MaxCount, int MaxSeconds, int ExchangeSeconds, bool Acknowledged);
public sealed record HybridExchange(int Number, string At, string Method, int? StatusCode, string Outcome, string RequestBody, string ResponseBody, bool RequestTruncated, bool ResponseTruncated, IReadOnlyList<HybridHeader> RequestHeaders, IReadOnlyList<HybridHeader> ResponseHeaders, string Summary);
public sealed record HybridResult(string OperationId, string ProfileId, string Namespace, string Name, string Mode, string Status, string Reason, IReadOnlyList<HybridExchange> Exchanges, double ElapsedMs, string Summary, string? CleanupWarning);
public sealed record HybridProgress(string OperationId, int Count, int MaxCount, string Phase, double ElapsedMs)
{
	public string Type => "hybrid-progress";
}
