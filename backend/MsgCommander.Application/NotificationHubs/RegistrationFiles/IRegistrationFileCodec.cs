using MsgCommander.Contracts.NotificationHubs.RegistrationFiles;
using MsgCommander.Contracts.NotificationHubs.Registrations;

namespace MsgCommander.Application.NotificationHubs.RegistrationFiles;

public sealed record PreparedRegistrationEntry(string? RegistrationId, string Kind, string Platform, bool Template, IReadOnlyList<string> Tags, string? Handle, string RawXml, NotificationHubRegistrationDraft? Draft, string? Issue);
public sealed record PreparedRegistrationFile(string SourceNamespace, string SourceHub, IReadOnlyList<PreparedRegistrationEntry> Entries);
public interface IRegistrationFileCodec
{
	string Format
	{
		get;
	}

	PreparedRegistrationFile Decode(string contentBase64, CancellationToken cancellation);
	byte[] Encode(RegistrationFileArchive archive, string format);
}
