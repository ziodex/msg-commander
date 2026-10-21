using System.Text.Json;
using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.NotificationHubs.Management;
namespace MsgCommander.Contracts.NotificationHubs.Credentials;

public sealed record NotificationHubCredentialStatus(string Provider, bool Configured, string Revision, string ApiVersion);
public sealed record NotificationHubCredentialArtifact(string ArtifactId, string Provider, string Summary, string ExpiresAt);
public sealed record NotificationHubCredentialImport(string Id, string ConnectionId, NotificationHubTarget Target, string Provider, string Password, string ContentBase64)
{
	public override string ToString() => $"{Provider} credential import";
}
public sealed record NotificationHubCredentialChange(string Id, string ConnectionId, NotificationHubTarget Target, string ExpectedRevision, JsonElement Draft, bool Acknowledged);
