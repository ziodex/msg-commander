namespace MsgCommander.Contracts.ServiceBus.Entities;

public sealed record RuntimeEntity(EntityTarget Target, EntityCounts Counts);
public sealed record RuntimePage(IReadOnlyList<RuntimeEntity> Items, string? ContinuationToken, string FetchedAt);
