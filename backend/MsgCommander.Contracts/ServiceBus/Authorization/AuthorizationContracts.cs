using MsgCommander.Contracts.AccessPolicies;

namespace MsgCommander.Contracts.ServiceBus.Authorization;

public sealed record AuthorizationContext(string ResourceId, string TenantId, string ClientId);
public sealed record AuthorizationTarget(string Kind, string? Name = null);
public sealed record AuthorizationSession(string AuthorizationId, string ResourceId);
public sealed record AuthorizationPage(IReadOnlyList<AuthorizationRule> Items);
public sealed record AuthorizationScope(string AuthorizationId, AuthorizationTarget Target);
public sealed record AuthorizationChange(AuthorizationScope Scope, string Action, string Name, IReadOnlyList<string>? Rights,
	string? ExpectedRevision, string? KeyType, string? Confirmation);
