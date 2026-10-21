using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.NotificationHubs.Management;
using MsgCommander.Contracts.NotificationHubs.Registrations;
using MsgCommander.Contracts.NotificationHubs.RegistrationFiles;
using MsgCommander.Contracts.NotificationHubs.Jobs;
using MsgCommander.Contracts.NotificationHubs.Notifications;
using MsgCommander.Contracts.Connections;
using MsgCommander.Application.NotificationHubs.Management;
using System.Net;

namespace MsgCommander.Infrastructure.NotificationHubs.Registrations;

internal static class RegistrationFiles
{
	internal const int Limit = 524288;
	internal const string Format = "msg-commander/notification-hub-registrations";
	internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
	{
		UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow,
		RespectRequiredConstructorParameters = true
	};
	private static OperationException Invalid() => new(OperationFailure.InvalidInput, "Invalid registration file. Use Commander registration JSON v1, a registration description, or an Azure Atom entry/feed. Check duplicate fields, required metadata and the 100-registration / 512 KiB limits.");
	internal static string? Identity(string? id)
	{
		if (id is not null && (string.IsNullOrWhiteSpace(id) || id.Length > 256 || id.Any(char.IsControl) || id is "." or ".." || id.Contains('/') || id.Contains('\\')))
			throw Invalid();
		return id;
	}

	internal static XElement Description(string xml)
	{
		var root = RegistrationXml.Parse(xml);
		if (root.Name.LocalName == "RegistrationDescription" && root.Attribute(XName.Get("type", "http://www.w3.org/2001/XMLSchema-instance")) is { } type)
		{
			var parts = type.Value.Split(':');
			if (parts.Length > 2)
				throw Invalid();
			var ns = parts.Length == 1 ? root.GetDefaultNamespace() : root.GetNamespaceOfPrefix(parts[0]);
			var name = parts[^1];
			if (ns != RegistrationXml.Service || !Regex.IsMatch(name, @"^[A-Za-z][A-Za-z0-9]{0,104}RegistrationDescription$"))
				throw Invalid();
			root.Name = RegistrationXml.Service + name;
			type.Remove();
		}

		if (root.Name.LocalName.Length > 128)
			throw Invalid();
		return root;
	}

	internal static void Validate(RegistrationFileArchive archive)
	{
		if (archive is null || !DocumentFormats.Matches(archive.Format, Format) || archive.Version != 1 || !DateTimeOffset.TryParse(archive.ExportedAt, out _) || archive.SourceNamespace is null || (archive.SourceNamespace != "Unknown" && !Regex.IsMatch(archive.SourceNamespace, @"^[A-Za-z][A-Za-z0-9-]{0,49}\.servicebus\.windows\.net$")) || archive.SourceHub is null || archive.Registrations is null || archive.Registrations.Count is < 1 or > 100)
			throw Invalid();
		if (archive.SourceHub != "Unknown")
			new NotificationHubScope("hub", archive.SourceHub).Validate();
		var ids = new HashSet<string>(StringComparer.Ordinal);
		foreach (var r in archive.Registrations)
		{
			Identity(r.RegistrationId);
			if (r.Etag is not null && (r.Etag.Length > 512 || r.Etag.Any(char.IsControl)) || !DateTimeOffset.TryParse(r.CapturedAt, out _))
				throw Invalid();
			var root = Description(r.RawXml);
			var id = Identity(root.Element(RegistrationXml.Service + "RegistrationId")?.Value);
			if (id is not null && r.RegistrationId is not null && id != r.RegistrationId)
				throw Invalid();
			var effective = r.RegistrationId ?? id;
			if (effective is not null && !ids.Add(effective))
				throw Invalid();
		}
	}

	internal static RegistrationFileArchive Decode(string base64)
	{
		try
		{
			if (base64 is null || base64.Length > 699052)
				throw Invalid();
			var bytes = Convert.FromBase64String(base64);
			if (bytes.Length > Limit)
				throw Invalid();
			var utf16 = bytes.Length >= 2 && ((bytes[0] == 255 && bytes[1] == 254) || (bytes[0] == 254 && bytes[1] == 255));
			var text = utf16 ? "" : new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF', ' ', '\t', '\r', '\n');
			RegistrationFileArchive archive;
			if (text.StartsWith('{'))
			{
				using var document = JsonDocument.Parse(text, new()
				{
					MaxDepth = 24
				});
				static void Unique(JsonElement node)
				{
					if (node.ValueKind == JsonValueKind.Object)
					{
						var names = new HashSet<string>(StringComparer.Ordinal);
						foreach (var p in node.EnumerateObject())
						{
							if (!names.Add(p.Name))
								throw Invalid();
							Unique(p.Value);
						}
					}
					else if (node.ValueKind == JsonValueKind.Array)
						foreach (var v in node.EnumerateArray())
							Unique(v);
				}

				Unique(document.RootElement);
				archive = document.RootElement.Deserialize<RegistrationFileArchive>(Json)!;
			}
			else
			{
				using var stream = new MemoryStream(bytes);
				using var reader = XmlReader.Create(stream, new()
				{
					DtdProcessing = DtdProcessing.Prohibit,
					XmlResolver = null,
					MaxCharactersInDocument = Limit
				});
				var root = XDocument.Load(reader).Root!;
				if (root is null || root.DescendantsAndSelf().Any(e => e.Ancestors().Take(33).Count() > 32))
					throw Invalid();
				var atom = RegistrationXml.Atom;
				IEnumerable<XElement> descriptions;
				static XElement FromEntry(XElement entry)
				{
					var contents = entry.Elements(RegistrationXml.Atom + "content").ToArray();
					if (contents.Length != 1 || contents[0].Elements().Count() != 1)
						throw Invalid();
					return contents[0].Elements().Single();
				}

				if (root.Name == atom + "feed")
				{
					if (root.Elements().Any(e => e.Name.Namespace != atom || (e.Name != atom + "entry" && !new[] { "title", "id", "updated", "link", "author", "subtitle", "generator" }.Contains(e.Name.LocalName))))
						throw Invalid();
					descriptions = root.Elements(atom + "entry").Select(FromEntry);
				}
				else if (root.Name == atom + "entry")
					descriptions = [FromEntry(root)];
				else
					descriptions = [root];
				var now = MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow);
				var rows = descriptions.Select(e =>
				{
					var d = Description(e.ToString());
					return new RegistrationFileRecord(Identity(d.Element(RegistrationXml.Service + "RegistrationId")?.Value), null, now, d.ToString());
				}).ToArray();
				archive = new(Format, 1, now, "Unknown", "Unknown", rows);
			}

			Validate(archive);
			return archive with
			{
				Format = Format
			};
		}
		catch (OperationException)
		{
			throw Invalid();
		}
		catch (Exception e) when (e is XmlException or JsonException or FormatException or InvalidOperationException or ArgumentException or DecoderFallbackException or NullReferenceException)
		{
			throw Invalid();
		}
	}

	internal static byte[] Encode(RegistrationFileArchive archive, string format)
	{
		Validate(archive);
		byte[] bytes;
		if (format == "json")
			bytes = JsonSerializer.SerializeToUtf8Bytes(archive with
			{
				Format = Format
			}, new JsonSerializerOptions(Json) { WriteIndented = true });
		else if (format == "xml")
		{
			var atom = RegistrationXml.Atom;
			var root = new XElement(atom + "feed", archive.Registrations.Select(r => new XElement(atom + "entry", r.Etag is null ? null : new XAttribute(XName.Get("etag", "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"), r.Etag), new XElement(atom + "content", new XAttribute("type", "application/xml"), RegistrationXml.Parse(r.RawXml)))));
			using var stream = new MemoryStream();
			using (var writer = XmlWriter.Create(stream, new()
			{
				Encoding = new UTF8Encoding(false),
				Indent = true
			}))
				new XDocument(root).Save(writer);
			bytes = stream.ToArray();
		}
		else
			throw Invalid();
		if (bytes.Length > Limit)
			throw new OperationException(OperationFailure.OperationBlocked, "Registration export exceeds 512 KiB. Select fewer rows; no partial file was saved.");
		return bytes;
	}
}
