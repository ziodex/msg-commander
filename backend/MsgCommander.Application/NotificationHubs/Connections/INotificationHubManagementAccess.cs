using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.NotificationHubs.Management;

namespace MsgCommander.Application.NotificationHubs.Connections;

public sealed record NotificationHubManagementConnect(string OperationId, ConnectionProfile Profile, NotificationHubManagement Management);
public sealed record NotificationHubPolicyCredential(string ManagementConnectionId, ConnectionProfile Profile, string Source,
	NotificationHubTarget Target, string KeyType, bool Sending);

/// <summary>Data-plane owners validate policy-derived credentials through this narrow management port.</summary>
public interface INotificationHubManagementAccess
{
	Task RequireAsync(string connectionId, string profileId, CancellationToken cancellation);
	Task<ConnectionProfile> CredentialAsync(NotificationHubPolicyCredential request, CancellationToken cancellation);
}
