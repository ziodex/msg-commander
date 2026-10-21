using System.Text.Json;
using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.NotificationHubs.Management;
namespace MsgCommander.Contracts.NotificationHubs.Management;

public sealed record NotificationHubManagement(string ResourceId, string TenantId, string ClientId);
public sealed record NotificationHubScope(string Kind, string Name);
public sealed record NotificationHubTarget(NotificationHubScope Scope, string? PolicyName);
public sealed record NotificationHubTag(string Name, string Value);
public sealed record NotificationHubSettings(string RegistrationTtl, IReadOnlyList<NotificationHubTag> Tags);
public sealed record NotificationHubDetails(NotificationHubTarget Target, string Revision, NotificationHubSettings? Settings, IReadOnlyList<string>? Rights, IReadOnlyList<PropertyValue> Properties, string? Warning);
public sealed record NotificationHubItem(NotificationHubTarget Target, string? RegistrationTtl, IReadOnlyList<string>? Rights);
public sealed record NotificationHubPage(IReadOnlyList<NotificationHubItem> Items, string? ContinuationToken);
public sealed record NotificationHubConnection(string ConnectionId, string ProfileId, string Namespace, string ResourceId, string ConnectedAt, string Location);
public sealed record NotificationHubChange(string Id, string ConnectionId, NotificationHubTarget Target, string Action, string? ExpectedRevision, NotificationHubSettings? Settings, IReadOnlyList<string>? Rights, string? KeyType, bool Acknowledged);
public sealed record NotificationHubOutcome(string OperationId, NotificationHubTarget Target, string Action, string Status, string Summary);
