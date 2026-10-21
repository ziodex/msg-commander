using MsgCommander.Contracts.NotificationHubs.Registrations;

namespace MsgCommander.Contracts.NotificationHubs.RegistrationFiles;

public sealed record RegistrationFileRecord(string? RegistrationId, string? Etag, string CapturedAt, string RawXml);
public sealed record RegistrationFileArchive(string Format, int Version, string ExportedAt, string SourceNamespace, string SourceHub, IReadOnlyList<RegistrationFileRecord> Registrations);
public sealed record RegistrationFileEntry(string Id, string? RegistrationId, string Kind, string Platform, bool Template, IReadOnlyList<string> Tags, string? Handle, string Action, string? Issue);
public sealed record RegistrationFilePreview(string ImportId, string SourceNamespace, string SourceHub, string DestinationNamespace, string DestinationHub, string ExpiresAt, IReadOnlyList<RegistrationFileEntry> Entries, IReadOnlyList<string> Warnings);
public sealed record RegistrationFileApply(string Id, string ConnectionId, string ImportId, IReadOnlyList<string> EntryIds, bool Acknowledge);
public sealed record RegistrationFileStep(string EntryId, string Status, NotificationHubRegistrationOutcome? Receipt);
public sealed record RegistrationFileResult(string OperationId, string Status, string Summary, IReadOnlyList<RegistrationFileStep> Steps);
public sealed record RegistrationFileEncoded(string ContentBase64, int Count);
public sealed record RegistrationFileDefinition(string EntryId, string RawXml, IReadOnlyList<string> Tags);
public sealed record RegistrationFileProgress(string OperationId, int Percent, string Message)
{
	public string Type => "progress";
}
