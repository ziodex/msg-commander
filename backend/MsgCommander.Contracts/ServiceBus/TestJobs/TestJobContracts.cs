using System.Text.Json.Serialization;

namespace MsgCommander.Contracts.ServiceBus.TestJobs;

public sealed record TestJobTarget(string Kind, string Name, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? TopicName = null);
public sealed record TestGenerator(string Kind, int Seed, int SizeBytes);
public sealed record TestJobRequest(string Id, string ConnectionId, TestJobTarget Target, string Mode, int MaxMessages, int MaxSeconds, int DelayMs, int Workers, int BatchSize, string SessionId, string Body, string ContentType, bool Acknowledged, TestGenerator Generator, string Settlement, string DeadLetterReason, string DeadLetterDescription);
public sealed record TestLatencySummary(int Samples, double? MinMs, double? MeanMs, double? P50Ms, double? P95Ms, double? P99Ms, double? MaxMs);
public sealed record TestLatencies(TestLatencySummary Send, TestLatencySummary Receive, TestLatencySummary Complete, TestLatencySummary Settle);
public sealed record TestWorkerResult(int Worker, int Sent, int Received, int Completed, int Settled, int Abandoned, int Deferred, int DeadLettered, int Redelivered, int Uncertain, long ElapsedMs, int SendBatches, int ReceiveCalls, IReadOnlyList<string> UncertainMessageIds, string? UncertainSequenceNumber);
public sealed record TestJobResult(string OperationId, TestJobTarget Target, string Mode, string SessionId, int MaxMessages, int MaxSeconds, int DelayMs, int Workers, int BatchSize, int Sent, int Received, int Completed, int Settled, int Abandoned, int Deferred, int DeadLettered, int Redelivered, int Uncertain, int SendBatches, int ReceiveCalls, long ElapsedMs, TestLatencies Latency, IReadOnlyList<TestWorkerResult> WorkerResults, string Status, string Reason, string? LastMessageId, string? LastSequenceNumber, string Summary, string? CleanupWarning, TestGenerator Generator, string Settlement, IReadOnlyList<string> DeferredSequenceNumbers, string? ReferenceWarning);
public sealed record TestJobProgress(string OperationId, string Mode, int MaxMessages, int Workers, int BatchSize, int ActiveWorkers, int Sent, int Received, int Completed, int Settled, int Abandoned, int Deferred, int DeadLettered, int Redelivered, int Uncertain, int SendBatches, int ReceiveCalls, long ElapsedMs, string Phase, string Settlement)
{
	public string Type => "test-job-progress";
}

public sealed record TestPayloadPreviewResult(string ContentBase64, string ContentType, int ByteLength, int SampleIndex);
