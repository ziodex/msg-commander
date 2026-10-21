using MsgCommander.Contracts.NotificationHubs.Management;

namespace MsgCommander.Contracts.NotificationHubs.Registrations;

public sealed record NotificationHubRegistrationsConnect(string Id, string ProfileId, string HubName, string Source, string? ManagementConnectionId, NotificationHubTarget? PolicyTarget, string? KeyType);
public sealed record NotificationHubRegistrationQuery(string Mode, string Value, string HandleKind, int PageSize);
public sealed record NotificationHubRegistrationsConnection(string ConnectionId, string ProfileId, string Namespace, string HubName, string Source, string? ManagementConnectionId, string ConnectedAt);
public sealed record NotificationHubRegistration(string SnapshotId, string RegistrationId, string Kind, string Platform, bool Template, string? ExpirationTime, IReadOnlyList<string> Tags, string? Handle);
public sealed record NotificationHubRegistrationsPage(IReadOnlyList<NotificationHubRegistration> Items, string? ContinuationToken, string CapturedAt);
public sealed record NotificationHubRegistrationDetails(NotificationHubRegistration Registration, string CapturedAt, string? Etag, string? TemplateBody, string RawXml, string? Warning);
public sealed record NotificationHubRegistrationDraft(string RawXml, IReadOnlyList<string> Tags);
public sealed record NotificationHubRegistrationChange(string Id, string ConnectionId, string Action, string? SnapshotId, NotificationHubRegistrationDraft? Draft, bool Acknowledge);
public sealed record NotificationHubRegistrationOutcome(string OperationId, string Action, string Status, string Summary, string? RegistrationId, string? Etag, string? SnapshotId);
