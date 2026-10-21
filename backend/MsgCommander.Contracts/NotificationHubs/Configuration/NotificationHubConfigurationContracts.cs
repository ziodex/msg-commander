using System.Text.Json;
using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.NotificationHubs.Management;
namespace MsgCommander.Contracts.NotificationHubs.Configuration;

public sealed record NotificationHubConfigExport(string ContentBase64, int Count, IReadOnlyList<string> Warnings);
public sealed record NotificationHubConfigProgress(string OperationId, int Percent, string Message)
{
	public string Type => "progress";
}

public sealed record NotificationHubConfigPolicy(string Name, IReadOnlyList<string> Rights);
public sealed record NotificationHubConfigResource(string Name, NotificationHubSettings? Settings, IReadOnlyList<NotificationHubConfigPolicy> Policies, bool ReplaceTags);
public sealed record NotificationHubConfigArchive(string Format, int Version, string ExportedAt, string SourceNamespace, IReadOnlyList<NotificationHubConfigResource> Resources, IReadOnlyList<NotificationHubConfigPolicy> NamespacePolicies, IReadOnlyList<string> Warnings);
public sealed record NotificationHubConfigEntry(string Id, NotificationHubTarget Target, string Action, NotificationHubSettings? Settings, IReadOnlyList<string>? Rights, NotificationHubSettings? CurrentSettings, IReadOnlyList<string>? CurrentRights, string? Issue);
public sealed record NotificationHubConfigPreview(string ImportId, string SourceNamespace, string DestinationNamespace, string ExpiresAt, IReadOnlyList<NotificationHubConfigEntry> Entries, IReadOnlyList<string> Warnings);
public sealed record NotificationHubConfigApply(string Id, string ConnectionId, string ImportId, IReadOnlyList<string> EntryIds, bool Acknowledged);
public sealed record NotificationHubConfigStep(NotificationHubTarget Target, string Status, NotificationHubOutcome? Receipt);
public sealed record NotificationHubConfigResult(string OperationId, string Status, string Summary, IReadOnlyList<NotificationHubConfigStep> Steps);
