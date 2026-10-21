using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.NotificationHubs.Management;
using MsgCommander.Contracts.NotificationHubs.Registrations;
using MsgCommander.Contracts.NotificationHubs.RegistrationFiles;
using MsgCommander.Contracts.NotificationHubs.Jobs;
using MsgCommander.Contracts.NotificationHubs.Notifications;
using MsgCommander.Contracts.Connections;
using MsgCommander.Application.NotificationHubs.Management;

namespace MsgCommander.Application.NotificationHubs.Gateways;

public sealed record NotificationHubRegistrationGatewayPage(IReadOnlyList<NotificationHubRegistrationDetails> Items, string? ContinuationToken);
public interface INotificationHubRegistrationsGatewayFactory
{
	INotificationHubRegistrationsGateway Create(ConnectionProfile profile, string hubName);
}

public interface INotificationHubRegistrationsGateway : IRegistrationCatalogGateway, IRegistrationJobsGateway, INotificationSendGateway, IAsyncDisposable;
public interface IRegistrationJobsGateway
{
	Task<NotificationHubJobsPage> ListJobsAsync(CancellationToken cancellation);
	Task<NotificationHubJob> GetJobAsync(string jobId, CancellationToken cancellation);
	Task<NotificationHubJob> SubmitJobAsync(NotificationHubJobDraft draft, Action dispatched, Action acknowledged, CancellationToken cancellation);
}

public interface INotificationSendGateway
{
	Task<NotificationSendDetails> TestSendAsync(NotificationDraft draft, Action dispatched, CancellationToken cancellation);
}

public interface IRegistrationCatalogGateway
{
	Task<NotificationHubRegistrationDetails> GetAsync(string registrationId, CancellationToken cancellation);
	Task<NotificationHubRegistrationDetails?> ChangeAsync(NotificationHubRegistrationChange change, NotificationHubRegistrationDetails? original, Action dispatched, CancellationToken cancellation);
	Task<NotificationHubRegistrationGatewayPage> QueryAsync(NotificationHubRegistrationQuery query, string? continuation, CancellationToken cancellation);
}
