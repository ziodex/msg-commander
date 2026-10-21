using MsgCommander.Contracts.ServiceBus.TestJobs;

namespace MsgCommander.Application.ServiceBus.TestJobs;

public sealed record TestJobMessage(byte[] Body, string ContentType, string SessionId, string MessageId, string JobId, int Index);
public sealed record TestJobDelivery(string Handle, long SequenceNumber, string? MessageId);
public enum TestJobError
{
	InvalidRequest, ResourceLimit, ReceiverContract
}
public sealed class TestJobException(TestJobError error, string message) : Exception(message)
{
	public TestJobError Error { get; } = error;
}
public sealed class TestJobTransportException(bool rejected, string safeMessage) : Exception(safeMessage)
{
	public bool Rejected { get; } = rejected;
}
public interface ITestMessageSender : IAsyncDisposable
{
	Task SendBatchAsync(IReadOnlyList<TestJobMessage> messages, Action<int, int> dispatching,
		Action<int, int, double> acknowledged, CancellationToken cancellation);
}
public interface ITestJobReceiver : IAsyncDisposable
{
	DateTimeOffset? SessionLockedUntil
	{
		get;
	}
	Task RenewSessionLockAsync(CancellationToken cancellation);
	Task<IReadOnlyList<TestJobDelivery>> ReceiveAsync(int count, TimeSpan wait, CancellationToken cancellation);
	Task SettleAsync(TestJobDelivery delivery, string action, string reason, string description, CancellationToken cancellation);
}
public interface ITestJobGateway
{
	bool HasOwnedReceiver
	{
		get;
	}
	Task<bool?> RequiresSessionAsync(TestJobTarget target, CancellationToken cancellation);
	ITestMessageSender OpenSender(TestJobTarget target);
	Task<ITestJobReceiver> OpenReceiverAsync(TestJobTarget target, string sessionId, CancellationToken cancellation);
	string? RecordDeferred(TestJobTarget target, string sessionId, long sequence);
	void InvalidateSnapshots();
}
