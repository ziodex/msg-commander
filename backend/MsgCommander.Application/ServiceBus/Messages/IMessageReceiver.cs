using MsgCommander.Application.ServiceBus.TestJobs;
using MsgCommander.Contracts.ServiceBus.Entities;

namespace MsgCommander.Application.ServiceBus.Messages;

public interface IMessageReceiver : ITestJobMessageReceiver
{
	string? SessionId
	{
		get;
	}
	Task<MessageBody?> GetSessionStateAsync(CancellationToken cancellation);
	Task SetSessionStateAsync(MessageBody? state, CancellationToken cancellation);
	Task<ReceivedMessage> ReceiveDeferredAsync(long sequence, CancellationToken cancellation);
	DateTimeOffset LockedUntil(ReceivedMessage message);
	Task ReplayAsync(ReceivedMessage original, EntityTarget destination, OutgoingMessage outgoing, CancellationToken cancellation);
}
