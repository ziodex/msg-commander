using System.Text.Json;

namespace MsgCommander.Contracts.ResourceConfiguration;

public sealed record MessagingConfigTarget(string Kind, string Name, string? ParentKind, string? ParentName);
public sealed record MessagingConfigResource(MessagingConfigTarget Target, JsonElement Settings, bool RulesSpecified, string? Issue);
public sealed record MessagingConfigArchive(string Format, int Version, string Service, string ExportedAt, string SourceNamespace, IReadOnlyList<MessagingConfigResource> Resources, IReadOnlyList<string> Warnings);
public sealed record MessagingConfigSnapshot(MessagingConfigResource Resource, string Revision, string Identity);
public sealed record MessagingConfigEntry(string Id, MessagingConfigTarget Target, string Phase, string Action, JsonElement Proposed, JsonElement? Current, IReadOnlyList<string> DependsOn, string? Issue);
public sealed record MessagingConfigPreview(string ImportId, string Service, string SourceNamespace, string DestinationNamespace, string ExpiresAt, IReadOnlyList<MessagingConfigEntry> Entries, IReadOnlyList<string> Warnings);
public sealed record MessagingConfigApply(string Id, string ConnectionId, string Service, string ImportId, IReadOnlyList<string> EntryIds, bool Acknowledged);
public sealed record MessagingConfigStep(string EntryId, MessagingConfigTarget Target, string Phase, string Status, string Summary);
public sealed record MessagingConfigResult(string OperationId, string Service, string Status, string Summary, IReadOnlyList<MessagingConfigStep> Steps);
public sealed record MessagingConfigExportRequest(string Service, MessagingConfigTarget? Scope, string Format, bool IncludePolicies);
public sealed record MessagingConfigExport(string ContentBase64, int Count, IReadOnlyList<string> Warnings);
public sealed record MessagingConfigPreviewRequest(string Service, string ContentBase64);
public sealed record MessagingConfigProgress(string OperationId, int Percent, string Message)
{
	public string Type => "progress";
}
