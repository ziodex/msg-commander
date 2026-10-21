using MsgCommander.Contracts.ServiceBus.Entities;

namespace MsgCommander.Application.ServiceBus.Entities;

public interface IEntityReader
{
	Task<EntityDetails> GetEntityAsync(EntityTarget target, CancellationToken cancellation);
}
