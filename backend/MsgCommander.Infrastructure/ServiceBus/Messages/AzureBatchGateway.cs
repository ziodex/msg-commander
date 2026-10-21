using System.Globalization;
using Azure.Messaging.ServiceBus;

namespace MsgCommander.Infrastructure.ServiceBus;

public sealed partial class AzureServiceBusGateway
{
	public async Task<IReadOnlyList<long>> SendBatchAsync(EntityTarget target, IReadOnlyList<OutgoingMessage> messages, DateTimeOffset? scheduled, Action dispatching, CancellationToken cancellation)
	{
		OutgoingMessages.ValidateDestination(target);
		BatchSending.Validate(messages);
		await using var sender = messaging.CreateSender(target.Name);
		// The broker-negotiated AMQP size check happens for the entire set before any write.
		using var batch = await sender.CreateMessageBatchAsync(cancellation);
		var sdkMessages = messages.Select(AzureOutgoingMessage.ToSdk).ToArray();
		foreach (var message in sdkMessages)
		{
			if (scheduled is { } time)
				message.ScheduledEnqueueTime = time;
			if (!batch.TryAddMessage(message))
				throw new OperationException(OperationFailure.InvalidInput, "The complete batch exceeds the broker's batch size limit. Remove messages or reduce their size. Nothing was sent.");
		}
		cancellation.ThrowIfCancellationRequested();
		if (scheduled is { } enqueueTime)
			BatchSending.RequireFuture(enqueueTime);
		dispatching();
		if (scheduled is { } scheduledTime)
			return await sender.ScheduleMessagesAsync(sdkMessages, scheduledTime, cancellation);
		await sender.SendMessagesAsync(batch, cancellation);
		return [];
	}
	public async Task CancelScheduledAsync(EntityTarget target, IReadOnlyList<long> sequences, Action dispatching, CancellationToken cancellation)
	{
		OutgoingMessages.ValidateDestination(target);
		await using var sender = messaging.CreateSender(target.Name);
		cancellation.ThrowIfCancellationRequested();
		dispatching();
		await sender.CancelScheduledMessagesAsync(sequences, cancellation);
	}
}
