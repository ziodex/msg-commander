using MsgCommander.Application.NotificationHubs.Credentials;
using MsgCommander.Contracts.NotificationHubs.Management;
using MsgCommander.Contracts.NotificationHubs.Credentials;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.AccessPolicies;

namespace MsgCommander.Application.NotificationHubs.Gateways;

public interface INotificationHubGatewayFactory
{
	Task<INotificationHubGateway> ConnectAsync(ConnectionProfile profile, NotificationHubManagement management, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation);
}
public interface INotificationHubGateway : IAsyncDisposable
{
	string Location
	{
		get;
	}
	Task<NotificationHubDetails> GetAsync(NotificationHubTarget target, CancellationToken cancellation);
	Task<NotificationHubPage> ListAsync(NotificationHubScope scope, string kind, string? continuation, CancellationToken cancellation);
	Task<AuthorizationKey> KeyAsync(NotificationHubTarget target, string keyType, CancellationToken cancellation);
	Task<NotificationHubCredentialStatus> CredentialsAsync(NotificationHubTarget target, string provider, CancellationToken cancellation);
	Task ChangeCredentialAsync(NotificationHubTarget target, string provider, string revision, ProviderCredentialMaterial? material, Action dispatching, CancellationToken cancellation);
	Task ChangeAsync(NotificationHubChange change, Action dispatching, CancellationToken cancellation);
}
public sealed record NotificationHubFailure(bool Rejected, bool Denied, bool NotFound);
public interface INotificationHubFailureClassifier
{
	NotificationHubFailure Classify(Exception error);
}
