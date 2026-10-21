using Azure.Messaging.ServiceBus;
using Microsoft.Azure.Amqp;
using Microsoft.Azure.Amqp.Framing;

namespace MsgCommander.Infrastructure.ServiceBus.Connections;

public static class ReceiverDisposal
{
	public static async ValueTask DisposeAsync(ServiceBusReceiver receiver, ServiceBusClient client)
	{
		try
		{
			await receiver.DisposeAsync();
		}
		finally
		{
			try
			{
				await client.DisposeAsync();
			}
			catch (AmqpException error) when (receiver.IsClosed && client.IsClosed &&
				error.Error.Condition.Equals(AmqpErrorCode.IllegalState))
			{
				// SDK 7.21 closes the AMQP connection before closing its shared transaction
				// session. A faulted session can already be closing when that final close runs.
				// Both owned endpoints are closed: discard them without replaying any operation.
			}
			catch (OperationCanceledException) when (receiver.IsClosed && client.IsClosed)
			{
				// The same shared-session close can surface an earlier cancellation after the
				// SDK connection is closed. Disposal has no caller token; both owned endpoints
				// are discarded. Receiver failures and incomplete client cleanup still propagate.
			}
		}
	}
}
