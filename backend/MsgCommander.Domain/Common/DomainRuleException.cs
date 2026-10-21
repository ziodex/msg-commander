namespace MsgCommander.Domain.Common;

public sealed class DomainRuleException(string message) : ArgumentException(message);
