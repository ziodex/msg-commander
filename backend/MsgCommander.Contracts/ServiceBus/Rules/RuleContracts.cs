using MsgCommander.Contracts.Common;

namespace MsgCommander.Contracts.ServiceBus.Rules;

public sealed record CorrelationSettings(string? CorrelationId, string? MessageId, string? Subject, string? ContentType, string? To, string? ReplyTo, string? SessionId, string? ReplyToSessionId, IReadOnlyList<PropertyValue> Properties);
public sealed record RuleDefinition(string FilterType, string SqlExpression, IReadOnlyList<PropertyValue> FilterParameters, CorrelationSettings? Correlation, string ActionExpression, IReadOnlyList<PropertyValue> ActionParameters);
public sealed record RuleConfiguration(string Name, RuleDefinition Definition, string Revision, string? ReadOnlyReason);
public sealed record RuleSummary(string Name, string FilterType, bool HasAction);
public sealed record RulePage(IReadOnlyList<RuleSummary> Items, string? ContinuationToken);
