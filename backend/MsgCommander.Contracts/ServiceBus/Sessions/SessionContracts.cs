using MsgCommander.Contracts.ServiceBus.Entities;

namespace MsgCommander.Contracts.ServiceBus.Sessions;

public sealed record SessionPage(IReadOnlyList<string> Items, string? ContinuationToken);
public sealed record SessionLease(string LeaseId, EntityTarget Target, string SessionId, string LockedUntil, string Status, bool StateUncertain);
public sealed record SessionState(string LeaseId, bool IsSet, int Bytes, string? BodyBase64, string? Revision, bool Editable, string? Warning);
