using System.Transactions;
using Azure.Messaging.ServiceBus;
using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Infrastructure.ServiceBus.Connections;

namespace MsgCommander.Infrastructure.ServiceBus.Messages;

public sealed class AzureMessageReceiver(ServiceBusClient client, ServiceBusReceiver receiver) : IMessageReceiver
{
	private int disposed;
	public string? SessionId => (receiver as ServiceBusSessionReceiver)?.SessionId;
	public DateTimeOffset? SessionLockedUntil => (receiver as ServiceBusSessionReceiver)?.SessionLockedUntil;
	private ServiceBusSessionReceiver Session => receiver as ServiceBusSessionReceiver ??
		throw new OperationException(OperationFailure.InvalidInput, "Accept a session first.");
	public async Task<MessageBody?> GetSessionStateAsync(CancellationToken cancellation)
	{
		var value = await Session.GetSessionStateAsync(cancellation);
		return value is null ? null : MessageBody.FromBytes(value.ToMemory());
	}
	public Task SetSessionStateAsync(MessageBody? state, CancellationToken cancellation) =>
		Session.SetSessionStateAsync(state is null ? null : new BinaryData(state.ToMemory()), cancellation);
	public Task RenewSessionLockAsync(CancellationToken cancellation) => Session.RenewSessionLockAsync(cancellation);
	private AzureReceivedMessage Delivery(ServiceBusReceivedMessage message)
	{
		var view = AzureReceivedMessage.Delivery(message, this);
		view.Settled = receiver.ReceiveMode == ServiceBusReceiveMode.ReceiveAndDelete;
		return view;
	}
	public async Task<IReadOnlyList<ReceivedMessage>> ReceiveAsync(int count, TimeSpan wait, CancellationToken cancellation) =>
		(await receiver.ReceiveMessagesAsync(count, wait, cancellation)).Select(Delivery).ToArray();
	public async Task<ReceivedMessage> ReceiveDeferredAsync(long sequence, CancellationToken cancellation) =>
		Delivery(await receiver.ReceiveDeferredMessageAsync(sequence, cancellation));
	private AzureReceivedMessage Own(ReceivedMessage message, bool active = true)
	{
		if (Volatile.Read(ref disposed) != 0 || message is not AzureReceivedMessage owned ||
			!ReferenceEquals(owned.Owner, this) || (active && owned.Settled))
			throw new OperationException(OperationFailure.DeliveryExpired, "This message has no active owned receiver delivery.");
		return owned;
	}
	public DateTimeOffset LockedUntil(ReceivedMessage message)
	{
		var owned = Own(message, active: false);
		return receiver is ServiceBusSessionReceiver session ? session.SessionLockedUntil : owned.Message.LockedUntil;
	}
	public async Task SettleAsync(ReceivedMessage message, string action, string reason, string description, CancellationToken cancellation)
	{
		var owned = Own(message);
		await owned.SettlementGate.WaitAsync(cancellation);
		try
		{
			Own(message);
			switch (action)
			{
				case "complete":
					await receiver.CompleteMessageAsync(owned.Message, cancellation);
					break;
				case "abandon":
					await receiver.AbandonMessageAsync(owned.Message, cancellationToken: cancellation);
					break;
				case "dead-letter":
					await receiver.DeadLetterMessageAsync(owned.Message, reason, description, cancellation);
					break;
				case "defer":
					await receiver.DeferMessageAsync(owned.Message, cancellationToken: cancellation);
					break;
				case "renew" when receiver is ServiceBusSessionReceiver session:
					await session.RenewSessionLockAsync(cancellation);
					break;
				case "renew":
					await receiver.RenewMessageLockAsync(owned.Message, cancellation);
					break;
				default:
					throw new OperationException(OperationFailure.InvalidInput, "Unsupported settlement action.");
			}
			if (action != "renew")
				owned.Settled = true;
		}
		finally { owned.SettlementGate.Release(); }
	}
	public async Task ReplayAsync(ReceivedMessage original, EntityTarget destination, OutgoingMessage outgoing, CancellationToken cancellation)
	{
		OutgoingMessages.ValidateDestination(destination);
		var owned = Own(original);
		var copy = AzureOutgoingMessage.ToSdk(outgoing);
		await owned.SettlementGate.WaitAsync(cancellation);
		try
		{
			Own(original);
			await using var sender = client.CreateSender(destination.Name);
			using (var transaction = new TransactionScope(TransactionScopeOption.Required,
				new TransactionOptions { Timeout = TimeSpan.FromSeconds(60) }, TransactionScopeAsyncFlowOption.Enabled))
			{
				await receiver.CompleteMessageAsync(owned.Message, cancellation);
				await sender.SendMessageAsync(copy, cancellation);
				cancellation.ThrowIfCancellationRequested();
				transaction.Complete();
			}
			owned.Settled = true; // Record success only after transaction commit returns.
		}
		finally { owned.SettlementGate.Release(); }
	}
	public async ValueTask DisposeAsync()
	{
		if (Interlocked.Exchange(ref disposed, 1) != 0)
			return;
		await ReceiverDisposal.DisposeAsync(receiver, client);
	}
}
