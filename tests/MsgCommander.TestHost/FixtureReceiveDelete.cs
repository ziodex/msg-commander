using Azure.Messaging.ServiceBus;
using MsgCommander.Host;

sealed partial class FixtureGateway
{
	public async Task<IMessageReceiver> OpenReceiveDeleteReceiverAsync(EntityTarget target, string subQueue, string sessionId, CancellationToken cancellation)
	{
		if (target.Name == "consume-open-slow")
			await Task.Delay(10000, cancellation);
		return new DestructiveReceiver(this, target, (FixtureReceiver)await OpenReceiverAsync(target, subQueue, sessionId, cancellation));
	}
	private sealed class DestructiveReceiver(FixtureGateway gateway, EntityTarget target, FixtureReceiver inner) : IMessageReceiver
	{
		public string? SessionId => inner.SessionId;
		public DateTimeOffset? SessionLockedUntil => inner.SessionLockedUntil;
		public Task RenewSessionLockAsync(CancellationToken cancellation) => inner.RenewSessionLockAsync(cancellation);
		public Task<MessageBody?> GetSessionStateAsync(CancellationToken cancellation) => throw new InvalidOperationException();
		public Task SetSessionStateAsync(MessageBody? state, CancellationToken cancellation) => throw new InvalidOperationException();
		public DateTimeOffset LockedUntil(ReceivedMessage message) => throw new InvalidOperationException();
		public Task<ReceivedMessage> ReceiveDeferredAsync(long sequence, CancellationToken cancellation) => throw new InvalidOperationException();
		public Task SettleAsync(ReceivedMessage message, string action, string reason, string description, CancellationToken cancellation) => throw new InvalidOperationException("Receive-and-delete must never settle.");
		public Task ReplayAsync(ReceivedMessage original, EntityTarget destination, OutgoingMessage outgoing, CancellationToken cancellation) => throw new InvalidOperationException();
		public async Task<IReadOnlyList<ReceivedMessage>> ReceiveAsync(int count, TimeSpan wait, CancellationToken cancellation)
		{
			if (target.Name == "consume-receive-slow")
				await Task.Delay(10000, cancellation);
			var batch = await inner.ReceiveAsync(count, wait, cancellation);
			foreach (var message in batch)
			{
				gateway.Bucket(target, true).RemoveAll(item => item.Sequence == message.SequenceNumber);
				if (message.MessageId == "consume-unknown")
					throw new ServiceBusException("SECRET transfer lost", ServiceBusFailureReason.ServiceCommunicationProblem);
				if (message.MessageId == "consume-cancel-after-delete")
					await Task.Delay(10000, cancellation);
				if (message.MessageId == "consume-return-late")
					await Task.Delay(150);
			}
			return batch.Select(message => message.MessageId == "consume-oversized"
				? AzureReceivedMessage.Snapshot(ServiceBusModelFactory.ServiceBusReceivedMessage(body: new BinaryData(new byte[65 * 1024 * 1024]), messageId: message.MessageId, sequenceNumber: message.SequenceNumber))
				: message).ToArray();
		}
		public ValueTask DisposeAsync() => inner.DisposeAsync();
	}
}
