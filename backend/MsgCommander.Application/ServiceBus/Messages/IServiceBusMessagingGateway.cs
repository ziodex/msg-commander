using MsgCommander.Application.ServiceBus.TestJobs;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Entities;

namespace MsgCommander.Application.ServiceBus.Messages;

/// <summary>Messaging and the entity metadata needed to validate a messaging workflow.</summary>
public interface IServiceBusMessagingGateway : IEntityReader, IAsyncDisposable
{
	IAsyncEnumerable<string> ListSessionsAsync(EntityTarget target, CancellationToken cancellation);
	Task<ReceivedMessage?> PeekOneAsync(EntityTarget target, string subQueue, long fromSequenceNumber, CancellationToken cancellation);
	Task<IReadOnlyList<long>> SendBatchAsync(EntityTarget target, IReadOnlyList<OutgoingMessage> messages,
		DateTimeOffset? scheduled, Action dispatching, CancellationToken cancellation);
	Task CancelScheduledAsync(EntityTarget target, IReadOnlyList<long> sequences, Action dispatching, CancellationToken cancellation);
	ITestMessageSender OpenTestSender(EntityTarget target);
	Task SendAsync(EntityTarget target, OutgoingMessage message, CancellationToken cancellation);
	Task<IMessageReceiver> OpenReceiveDeleteReceiverAsync(EntityTarget target, string subQueue, string sessionId, CancellationToken cancellation);
	Task<IMessageReceiver> OpenNextSessionAsync(EntityTarget target, CancellationToken cancellation);
	Task<IMessageReceiver> OpenReceiverAsync(EntityTarget target, string subQueue, string sessionId, CancellationToken cancellation);
}
