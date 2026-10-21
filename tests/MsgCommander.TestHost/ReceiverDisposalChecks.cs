using Azure.Messaging.ServiceBus;
using Microsoft.Azure.Amqp;
using Microsoft.Azure.Amqp.Framing;
using MsgCommander.Infrastructure.ServiceBus.Connections;
using MsgCommander.Domain.ServiceBus.Entities;

static class ReceiverDisposalChecks
{
	sealed class Client(Exception? error = null, bool close = true) : ServiceBusClient
	{
		private bool closed;
		public int Disposals;
		public override bool IsClosed => closed;
		public override ValueTask DisposeAsync()
		{
			Disposals++;
			closed = close;
			return error is null ? ValueTask.CompletedTask : ValueTask.FromException(error);
		}
	}
	sealed class Receiver(Exception? error = null, bool close = true) : ServiceBusReceiver
	{
		private bool closed;
		public int Disposals;
		public override bool IsClosed => closed;
		public override ValueTask DisposeAsync()
		{
			Disposals++;
			closed = close;
			return error is null ? ValueTask.CompletedTask : ValueTask.FromException(error);
		}
	}
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	static AmqpException ClosingRace() => new(AmqpErrorCode.IllegalState, "Synthetic closed session");
	static async Task Reject(Receiver receiver, Client client, Exception expected)
	{
		try
		{
			await ReceiverDisposal.DisposeAsync(receiver, client);
		}
		catch (Exception error) when (ReferenceEquals(error, expected))
		{
			Assert(receiver.Disposals == 1 && client.Disposals == 1, "Attempt both owned endpoints exactly once");
			return;
		}
		throw new Exception("Unexpected disposal failure was hidden");
	}
	public static async Task<int> Run()
	{
		var receiver = new Receiver();
		var client = new Client(ClosingRace());
		await ReceiverDisposal.DisposeAsync(receiver, client);
		Assert(receiver.IsClosed && client.IsClosed && receiver.Disposals == 1 && client.Disposals == 1,
			"A closed shared AMQP session cannot prevent discarding a faulted receiver and client");
		var session = ClosingRace();
		await Reject(new Receiver(close: false), new Client(session), session);
		await Reject(new Receiver(), new Client(session, close: false), session);
		var otherAmqp = new AmqpException(AmqpErrorCode.ConnectionForced, "Synthetic transport failure");
		await Reject(new Receiver(), new Client(otherAmqp), otherAmqp);
		var unexpected = new IOException("Synthetic cleanup failure");
		await Reject(new Receiver(), new Client(unexpected), unexpected);
		var receiverError = ClosingRace();
		await Reject(new Receiver(receiverError), new Client(ClosingRace()), receiverError);
		var cancelledClose = new OperationCanceledException("Synthetic cancelled shared-session close");
		receiver = new Receiver();
		client = new Client(cancelledClose);
		await ReceiverDisposal.DisposeAsync(receiver, client);
		Assert(receiver.IsClosed && client.IsClosed && receiver.Disposals == 1 && client.Disposals == 1,
			"Cancellation from an already closed shared session does not prevent explicit reconnect");
		await Reject(new Receiver(close: false), new Client(cancelledClose), cancelledClose);
		await Reject(new Receiver(), new Client(cancelledClose, close: false), cancelledClose);
		await Reject(new Receiver(cancelledClose), new Client(), cancelledClose);
		await Reject(new Receiver(cancelledClose), new Client(new OperationCanceledException()), cancelledClose);
		Assert(EntityAddress.TryCreate("subscription", "audit", "events") is { SupportsReceiving: true }, "Subscription has its owning topic");
		Assert(EntityAddress.TryCreate("topic", "events") is { SupportsReceiving: false }, "Topics cannot own a receiving lease");
		Assert(EntityAddress.TryCreate("subscription", "audit") is null && EntityAddress.TryCreate("queue", " ") is null &&
			EntityAddress.TryCreate("queue", new string('a', 261)) is null, "Reject incomplete and oversized addresses");
		Console.WriteLine("Receiver disposal checks passed");
		return 0;
	}
}
