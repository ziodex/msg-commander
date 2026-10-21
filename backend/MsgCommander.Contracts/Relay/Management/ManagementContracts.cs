using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.Relay.Management;

namespace MsgCommander.Contracts.Relay.Management;

public sealed record RelayManagement(string ResourceId, string TenantId, string ClientId);
public sealed record RelayScope(string Kind, string Name);
public sealed record RelayTarget(RelayScope Scope, string? PolicyName)
{
	[System.Text.Json.Serialization.JsonIgnore]
	public string Display => (Scope.Kind == "namespace" ? "namespace" : Scope.Kind + "/" + Scope.Name) + (PolicyName is null ? "" : "/policies/" + PolicyName);
}

public sealed record RelaySettings(string UserMetadata, bool RequiresClientAuthorization, string? RelayType, bool? RequiresTransportSecurity);
public sealed record RelayDetails(RelayTarget Target, string Revision, RelaySettings? Settings, IReadOnlyList<string>? Rights, IReadOnlyList<PropertyValue> Properties, string? Warning);
public sealed record RelayItem(RelayTarget Target, int? ListenerCount, bool? RequiresClientAuthorization, string? RelayType, IReadOnlyList<string>? Rights);
public sealed record RelayPage(IReadOnlyList<RelayItem> Items, string? ContinuationToken);
public sealed record RelayConnection(string ConnectionId, string ProfileId, string Namespace, string ResourceId, string ConnectedAt, string Location);
public sealed record RelayChange(string Id, string ConnectionId, RelayTarget Target, string Action, string? ExpectedRevision, RelaySettings? Settings, IReadOnlyList<string>? Rights, string? KeyType, bool Acknowledged);
public sealed record RelayOutcome(string OperationId, RelayTarget Target, string Action, string Status, string Summary);
