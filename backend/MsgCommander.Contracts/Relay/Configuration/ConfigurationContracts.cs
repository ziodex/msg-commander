using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.Relay.Management;

namespace MsgCommander.Contracts.Relay.Configuration;

public sealed record RelayConfigPolicy(string Name, IReadOnlyList<string> Rights);
public sealed record RelayConfigResource(string Kind, string Name, RelaySettings? Settings, IReadOnlyList<RelayConfigPolicy> Policies);
public sealed record RelayConfigArchive(string Format, int Version, string ExportedAt, string SourceNamespace, IReadOnlyList<RelayConfigResource> Resources, IReadOnlyList<RelayConfigPolicy> NamespacePolicies, IReadOnlyList<string> Warnings);
public sealed record RelayConfigEntry(string Id, RelayTarget Target, string Action, RelaySettings? Settings, IReadOnlyList<string>? Rights, RelaySettings? CurrentSettings, IReadOnlyList<string>? CurrentRights, string? Issue);
public sealed record RelayConfigPreview(string ImportId, string SourceNamespace, string DestinationNamespace, string ExpiresAt, IReadOnlyList<RelayConfigEntry> Entries, IReadOnlyList<string> Warnings);
public sealed record RelayConfigApply(string Id, string ConnectionId, string ImportId, IReadOnlyList<string> EntryIds, bool Acknowledged);
public sealed record RelayConfigStep(RelayTarget Target, string Status, RelayOutcome? Receipt);
public sealed record RelayConfigResult(string OperationId, string Status, string Summary, IReadOnlyList<RelayConfigStep> Steps);
public sealed record RelayConfigEncoded(string ContentBase64, int Count, IReadOnlyList<string> Warnings);
public sealed record RelayConfigProgress(string OperationId, int Percent, string Message)
{
	public string Type => "progress";
}
