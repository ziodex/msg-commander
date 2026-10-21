using System.Text.Json;
using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.AccessPolicies;

namespace MsgCommander.Contracts.EventHubs.Administration;

public sealed record EventAdminTarget(string Kind, string Name, [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? HubName = null);
public sealed record EventAdminContext(string ResourceId, string Tier, bool LocalAuthDisabled);
public sealed record EventHubSettings(int PartitionCount, string Status, string CleanupPolicy, int? RetentionHours, int? TombstoneHours, int? MinCompactionLagMinutes, string UserMetadata, JsonElement Capture);
public sealed record EventAdminDetails(EventAdminTarget Target, string Revision, EventHubSettings? Hub, string? UserMetadata, IReadOnlyList<string>? Rights, IReadOnlyList<PropertyValue> Properties, string? Warning);
public sealed record EventPolicyPage(IReadOnlyList<AuthorizationRule> Items, string? ContinuationToken);
public sealed record EventAdminChange(string Id, string ConnectionId, EventAdminTarget Target, string Action, string? ExpectedRevision, EventHubSettings? Settings, string? UserMetadata, string[]? Rights, string? KeyType, bool Acknowledged, string Confirmation);
public sealed record EventAdminOutcome(string OperationId, EventAdminTarget Target, string Action, string Status, string Summary);
