namespace MsgCommander.Contracts.ServiceBus.Entities;

public sealed record EntityChange(string Action, EntityTarget Target, EntitySettings? Settings, string? ExpectedRevision, string? Confirmation);
