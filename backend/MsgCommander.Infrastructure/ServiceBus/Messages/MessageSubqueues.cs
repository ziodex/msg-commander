using Azure.Messaging.ServiceBus;
using MsgCommander.Application.Common;

namespace MsgCommander.Infrastructure.ServiceBus.Messages;

public static class MessageSubqueues
{
	public static SubQueue Parse(string value) => value switch
	{
		"active" => SubQueue.None,
		"dead-letter" => SubQueue.DeadLetter,
		"transfer-dead-letter" => SubQueue.TransferDeadLetter,
		_ => throw new OperationException(OperationFailure.InvalidInput, "Invalid message subqueue.")
	};
}
