using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.NotificationHubs.Management;
using MsgCommander.Contracts.NotificationHubs.Registrations;
using MsgCommander.Contracts.NotificationHubs.RegistrationFiles;
using MsgCommander.Contracts.NotificationHubs.Jobs;
using MsgCommander.Contracts.NotificationHubs.Notifications;
using MsgCommander.Contracts.Connections;
using MsgCommander.Application.NotificationHubs.Management;

namespace MsgCommander.Infrastructure.NotificationHubs.Registrations;

internal static class RegistrationXml
{
	internal static readonly XNamespace Atom = "http://www.w3.org/2005/Atom", Service = "http://schemas.microsoft.com/netservices/2010/10/servicebus/connect";
	internal static XElement Parse(string raw)
	{
		if (raw is null || Encoding.UTF8.GetByteCount(raw) > 131072)
			throw new OperationException(OperationFailure.InvalidInput, "Registration XML must fit within 128 KiB.");
		try
		{
			using var input = new StringReader(raw);
			using var reader = XmlReader.Create(input, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 131072 });
			var document = XDocument.Load(reader);
			var root = document.Root;
			if (root is null || root.Name.Namespace != Service || !root.Name.LocalName.EndsWith("RegistrationDescription", StringComparison.Ordinal) || root.DescendantsAndSelf().Any(e => e.Ancestors().Take(33).Count() > 32) || root.Elements().GroupBy(e => e.Name).Any(g => g.Count() > 1))
				throw new XmlException();
			return root;
		}
		catch (Exception e) when (e is XmlException or InvalidOperationException)
		{
			throw new OperationException(OperationFailure.InvalidInput, "Use one valid registration description XML element. DTDs, duplicate fields and excessive nesting are not allowed.");
		}
	}

	internal static string Etag(string? value)
	{
		// Body ETags can be bare; HTTP/Atom ETags can be quoted or weak. Never send '*'.
		if (value is null || value.Length > 512 || !Regex.IsMatch(value, @"^(?:W/)?""[^""\x00-\x20\x7f]+""$|^[A-Za-z0-9_:+/=.-]+$") || value == "*")
			throw new OperationException(OperationFailure.InvalidInput, "This registration has no usable ETag. Reload it before editing or deleting; unconditional overwrite is disabled.");
		return value.EndsWith('"') ? value : "\"" + value + "\"";
	}

	internal static XElement Prepare(NotificationHubRegistrationDraft draft, NotificationHubRegistrationDetails? original)
	{
		if (draft.Tags is null || draft.Tags.Count > 60 || draft.Tags.Distinct(StringComparer.Ordinal).Count() != draft.Tags.Count || draft.Tags.Any(t => t is null || !Regex.IsMatch(t, @"^[A-Za-z0-9_@#.:~-]{1,120}$")))
			throw new OperationException(OperationFailure.InvalidInput, "Use up to 60 unique registration tags, each 1–120 allowed characters.");
		var root = Parse(draft.RawXml);
		var kind = root.Name.LocalName;
		if (original is not null && (kind != original.Registration.Kind || (root.Element(Service + "RegistrationId") is { } id && id.Value != original.Registration.RegistrationId)))
			throw new OperationException(OperationFailure.InvalidInput, "Registration ID and platform type cannot be changed. Create a separate registration instead.");
		if (original is null && new[]
		{
			"RegistrationId",
			"ETag",
			"ExpirationTime"
		}.Any(n => root.Element(Service + n) is not null))
			throw new OperationException(OperationFailure.InvalidInput, "Azure assigns the new registration ID, ETag and expiration. Remove those read-only fields.");
		foreach (var name in new[]
		{
			"RegistrationId",
			"ETag",
			"ExpirationTime",
			"Tags"
		}

		)
			root.Element(Service + name)?.Remove();
		if (draft.Tags.Count > 0)
			root.AddFirst(new XElement(Service + "Tags", string.Join(',', draft.Tags)));
		var prefix = kind.Replace("TemplateRegistrationDescription", "", StringComparison.Ordinal).Replace("RegistrationDescription", "", StringComparison.Ordinal);
		var field = prefix switch
		{
			"Apple" => "DeviceToken",
			"Windows" or "Mpns" => "ChannelUri",
			"FcmV1" => "FcmV1RegistrationId",
			"Fcm" => "FcmRegistrationId",
			"Gcm" => "GcmRegistrationId",
			"Adm" => "AdmRegistrationId",
			"Baidu" => "BaiduUserId",
			"Browser" => "Endpoint",
			_ => null
		};
		if (field is null && original is null)
			throw new OperationException(OperationFailure.InvalidInput, "Choose a supported registration platform for creation.");
		if (field is not null)
		{
			var handle = root.Element(Service + field)?.Value;
			if (string.IsNullOrWhiteSpace(handle) || handle.Length > 4096 || handle.Any(char.IsControl) || (prefix == "Apple" && !Regex.IsMatch(handle, @"^(?:[A-Fa-f0-9]{2}){1,256}$")) || (prefix is "Windows" or "Mpns" && (!Uri.TryCreate(handle, UriKind.Absolute, out var uri) || (prefix == "Windows" ? uri.Scheme != "https" : uri.Scheme is not ("http" or "https")) || uri.UserInfo != "" || uri.Fragment != "")))
				throw new OperationException(OperationFailure.InvalidInput, "Enter a valid platform device handle (APNS hex token or push channel URI where required).");
			if (prefix == "Baidu" && string.IsNullOrWhiteSpace(root.Element(Service + "BaiduChannelId")?.Value))
				throw new OperationException(OperationFailure.InvalidInput, "Baidu registrations require both user ID and channel ID.");
			if (prefix == "Browser")
			{
				if (!Uri.TryCreate(handle, UriKind.Absolute, out var endpoint) || endpoint.Scheme != "https" || endpoint.UserInfo != "" || endpoint.Fragment != "")
					throw new OperationException(OperationFailure.InvalidInput, "Browser subscriptions require a valid HTTPS endpoint; it is never called by the desktop.");
				byte[] Decode(string name, int length)
				{
					var value = root.Element(Service + name)?.Value ?? "";
					try
					{
						if (!Regex.IsMatch(value, @"^[A-Za-z0-9_-]+={0,2}$"))
							throw new FormatException();
						var encoded = value.TrimEnd('=');
						var bytes = Convert.FromBase64String(encoded.Replace('-', '+').Replace('_', '/') + new string('=', (4 - encoded.Length % 4) % 4));
						if (bytes.Length != length || Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') != encoded)
							throw new FormatException();
						return bytes;
					}
					catch (FormatException)
					{
						throw new OperationException(OperationFailure.InvalidInput, "Browser subscriptions require a base64url 65-byte P256DH public key and 16-byte Auth secret.");
					}
				}

				var key = Decode("P256DH", 65);
				Decode("Auth", 16);
				if (key[0] != 4)
					throw new OperationException(OperationFailure.InvalidInput, "Use an uncompressed P-256 Browser public key.");
				try
				{
					using var ec = System.Security.Cryptography.ECDsa.Create(new System.Security.Cryptography.ECParameters { Curve = System.Security.Cryptography.ECCurve.NamedCurves.nistP256, Q = new() { X = key[1..33], Y = key[33..] } });
				}
				catch (System.Security.Cryptography.CryptographicException)
				{
					throw new OperationException(OperationFailure.InvalidInput, "Use a valid P-256 Browser public key.");
				}
			}
		}

		if (kind.Contains("Template", StringComparison.Ordinal))
		{
			if (string.IsNullOrWhiteSpace(root.Element(Service + "BodyTemplate")?.Value))
				throw new OperationException(OperationFailure.InvalidInput, "Template registrations require a template body.");
			if (prefix == "FcmV1")
			{
				try
				{
					using var json = System.Text.Json.JsonDocument.Parse(root.Element(Service + "BodyTemplate")!.Value, new()
					{
						MaxDepth = 32
					});
					if (json.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object || !json.RootElement.TryGetProperty("message", out var message) || message.ValueKind != System.Text.Json.JsonValueKind.Object)
						throw new System.Text.Json.JsonException();
				}
				catch (System.Text.Json.JsonException)
				{
					throw new OperationException(OperationFailure.InvalidInput, "FCM v1 templates require a JSON object with a message envelope. Convert legacy templates explicitly before creating a copy.");
				}
			}

			if (prefix is "Windows" or "Mpns")
			{
				var header = prefix == "Windows" ? "Wns" : "Mpns";
				var required = prefix == "Windows" ? "X-WNS-Type" : "X-WindowsPhone-Target";
				var headers = root.Element(Service + header + "Headers")?.Elements(Service + header + "Header").ToArray() ?? [];
				if (headers.Length > 32 || !headers.Any(h => string.Equals(h.Element(Service + "Header")?.Value, required, StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(h.Element(Service + "Value")?.Value)))
					throw new OperationException(OperationFailure.InvalidInput, $"This template requires the {required} header in {header}Headers XML.");
			}
		}

		// DataContract serializers expect base fields, platform fields, then template fields.
		// Retain extension elements and attributes, including future platform fields.
		if (field is not null)
		{
			var order = new[]
			{
				"Tags",
				"PushVariables",
				"DeviceToken",
				"ChannelUri",
				"FcmV1RegistrationId",
				"FcmRegistrationId",
				"GcmRegistrationId",
				"AdmRegistrationId",
				"BaiduUserId",
				"BaiduChannelId",
				"Endpoint",
				"P256DH",
				"Auth",
				"SecondaryTileName",
				"BodyTemplate",
				"Expiry",
				"WnsHeaders",
				"MpnsHeaders",
				"TemplateName",
				"Priority",
				"ApnsHeaders",
				"MessageType"
			};
			var elements = root.Elements().OrderBy(e =>
			{
				var index = e.Name.Namespace == Service ? Array.IndexOf(order, e.Name.LocalName) : -1;
				return index < 0 ? 100 : index;
			}).ToArray();
			root.ReplaceNodes(elements);
		}

		if (root.Element(Service + "BodyTemplate") is { } template)
			template.ReplaceNodes(new XCData(template.Value));
		if (Encoding.UTF8.GetByteCount(root.ToString()) > 131072)
			throw new OperationException(OperationFailure.InvalidInput, "Registration XML and tags together must fit within 128 KiB.");
		return root;
	}
}
