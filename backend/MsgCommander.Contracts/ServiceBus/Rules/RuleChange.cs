using MsgCommander.Contracts.ServiceBus.Entities;

namespace MsgCommander.Contracts.ServiceBus.Rules;

public sealed record RuleChange(string Action, EntityTarget Target, string Name, RuleDefinition? Definition, string? ExpectedRevision, string? Confirmation);
