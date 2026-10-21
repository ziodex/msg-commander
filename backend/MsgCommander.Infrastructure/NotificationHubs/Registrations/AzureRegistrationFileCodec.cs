using System.Security.Cryptography;
using System.Text;
using MsgCommander.Application.NotificationHubs.RegistrationFiles;

namespace MsgCommander.Infrastructure.NotificationHubs.Registrations;

public sealed class AzureRegistrationFileCodec : IRegistrationFileCodec
{
	public string Format => RegistrationFiles.Format;

	public byte[] Encode(RegistrationFileArchive archive, string format) => RegistrationFiles.Encode(archive, format);
	public PreparedRegistrationFile Decode(string contentBase64, CancellationToken cancellation)
	{
		var archive = RegistrationFiles.Decode(contentBase64);
		var entries = new List<PreparedRegistrationEntry>();
		var seen = new HashSet<string>(StringComparer.Ordinal);
		foreach (var record in archive.Registrations)
		{
			cancellation.ThrowIfCancellationRequested();
			var root = RegistrationFiles.Description(record.RawXml);
			var service = RegistrationXml.Service;
			var sourceId = record.RegistrationId ?? root.Element(service + "RegistrationId")?.Value;
			var kind = root.Name.LocalName;
			var tags = (root.Element(service + "Tags")?.Value ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
			var handle = new[]
			{
				"DeviceToken",
				"ChannelUri",
				"FcmV1RegistrationId",
				"FcmRegistrationId",
				"GcmRegistrationId",
				"AdmRegistrationId",
				"BaiduUserId",
				"Endpoint"
			}.Select(n => root.Element(service + n)?.Value).FirstOrDefault(v => !string.IsNullOrEmpty(v));
			if (tags.Length > 256 || tags.Any(t => t.Length > 256) || handle?.Length > 4096)
				throw new OperationException(OperationFailure.OperationBlocked, "Registration file metadata exceeds the local preview limit.");
			var prefix = kind.Replace("TemplateRegistrationDescription", "", StringComparison.Ordinal).Replace("RegistrationDescription", "", StringComparison.Ordinal);
			var platform = prefix switch
			{
				"Apple" => "APNS",
				"FcmV1" => "FCM v1",
				"Windows" => "WNS",
				"Adm" => "ADM",
				"Baidu" => "Baidu",
				"Mpns" => "MPNS",
				"Gcm" => "GCM (legacy)",
				"Fcm" => "FCM",
				_ => "Unknown"
			};
			foreach (var field in new[]
			{
				"RegistrationId",
				"ETag",
				"ExpirationTime"
			}

			)
				root.Element(service + field)?.Remove();
			NotificationHubRegistrationDraft? draft = null;
			string? issue = null;
			try
			{
				var proposed = new NotificationHubRegistrationDraft(root.ToString(), Array.AsReadOnly(tags));
				var prepared = RegistrationXml.Prepare(proposed, null);
				draft = proposed with
				{
					RawXml = prepared.ToString()
				};
				var stamp = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(draft.RawXml)));
				if (!seen.Add(stamp))
				{
					draft = null;
					issue = "An identical definition already appears earlier in this file. This duplicate is blocked.";
				}
			}
			catch (OperationException)
			{
				issue = "This registration cannot be created by the supported editor. Check platform, handle, tags, template and required headers. Its original fields remain available for inspection/export.";
			}

			entries.Add(new(sourceId, kind, platform, kind.Contains("Template", StringComparison.Ordinal), Array.AsReadOnly(tags), handle, draft?.RawXml ?? root.ToString(), draft, issue));
		}

		return new(archive.SourceNamespace, archive.SourceHub, entries.AsReadOnly());
	}
}
