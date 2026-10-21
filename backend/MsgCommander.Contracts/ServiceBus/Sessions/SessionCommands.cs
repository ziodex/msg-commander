using MsgCommander.Contracts.ServiceBus.Entities;
namespace MsgCommander.Contracts.ServiceBus.Sessions;

public sealed record AcceptSession(EntityTarget Target, string SessionId);
public sealed record ChangeSessionState(string LeaseId, string? BodyBase64, string? Confirmation, string ExpectedRevision);
