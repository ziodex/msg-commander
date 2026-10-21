using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.ServiceBus.Entities;

public sealed record EntityCreationOptions(bool? RequiresSession, bool? RequiresDuplicateDetection, bool? EnablePartitioning)
{
	public void EnsureUnchanged(EntityCreationOptions proposed)
	{
		if (this != proposed)
			throw new DomainRuleException("Sessions, duplicate detection and partitioning can only be chosen when creating the entity.");
	}
}
