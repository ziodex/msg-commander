namespace MsgCommander.Contracts.AccessPolicies;

public sealed record AuthorizationRule(string Name, IReadOnlyList<string> Rights, string Revision);
public sealed record AuthorizationKey(string Key, string ConnectionString);
