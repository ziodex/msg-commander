using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Application.ServiceBus.TestJobs;

namespace MsgCommander.Application.ServiceBus.TestJobs;

// Shared receive/settle capability used by bounded test-job workers.
public interface ITestJobMessageReceiver : IAsyncDisposable
{
	DateTimeOffset? SessionLockedUntil
	{
		get;
	}
	Task RenewSessionLockAsync(CancellationToken cancellation);
	Task<IReadOnlyList<ReceivedMessage>> ReceiveAsync(int count, TimeSpan wait, CancellationToken cancellation);
	Task SettleAsync(ReceivedMessage message, string action, string reason, string description, CancellationToken cancellation);
}

public sealed class MessageTestJobReceiver(ITestJobMessageReceiver receiver, Func<Exception, Exception>? translate = null) : ITestJobReceiver
{
	private readonly Dictionary<string, ReceivedMessage> held = [];
	private Exception Translate(Exception error) => translate?.Invoke(error) ?? error;
	public DateTimeOffset? SessionLockedUntil => receiver.SessionLockedUntil;
	public async Task RenewSessionLockAsync(CancellationToken cancellation)
	{
		try
		{
			await receiver.RenewSessionLockAsync(cancellation);
		}
		catch (Exception error) { throw Translate(error); }
	}
	public async Task<IReadOnlyList<TestJobDelivery>> ReceiveAsync(int count, TimeSpan wait, CancellationToken cancellation)
	{
		held.Clear();
		try
		{
			var messages = await receiver.ReceiveAsync(count, wait, cancellation);
			return messages.Select(message =>
			{
				var handle = Guid.NewGuid().ToString();
				held.Add(handle, message);
				return new TestJobDelivery(handle, message.SequenceNumber, message.MessageId);
			}).ToArray();
		}
		catch (Exception error) { throw Translate(error); }
	}
	public async Task SettleAsync(TestJobDelivery delivery, string action, string reason, string description, CancellationToken cancellation)
	{
		if (!held.TryGetValue(delivery.Handle, out var message) || message.SequenceNumber != delivery.SequenceNumber || message.MessageId != delivery.MessageId)
			throw new TestJobException(TestJobError.InvalidRequest, "The test delivery is no longer owned by this receiver.");
		try
		{
			await receiver.SettleAsync(message, action, reason, description, cancellation);
			held.Remove(delivery.Handle);
		}
		catch (Exception error) { throw Translate(error); }
	}
	public async ValueTask DisposeAsync()
	{
		held.Clear();
		await receiver.DisposeAsync();
	}
}
