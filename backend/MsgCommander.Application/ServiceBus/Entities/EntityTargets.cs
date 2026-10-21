using MsgCommander.Application.Common;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Domain.ServiceBus.Entities;

namespace MsgCommander.Application.ServiceBus.Entities;

public static class EntityTargets
{
	public static void Validate(this EntityTarget target, bool peek = false)
	{
		var address = EntityAddress.TryCreate(target.Kind, target.Name, target.TopicName);
		if (address is null || (peek && !address.SupportsReceiving))
			throw new OperationException(OperationFailure.InvalidInput, "Select a queue or subscription for peeking; subscriptions require their topic.");
	}
}
