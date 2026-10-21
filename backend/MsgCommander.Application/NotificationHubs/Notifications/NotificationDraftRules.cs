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
using MsgCommander.Application.AccessPolicies;
using MsgCommander.Application.NotificationHubs.Management;

namespace MsgCommander.Application.NotificationHubs.Notifications;

public static class NotificationDraftRules
{
	public static void Validate(this NotificationDraft value)
	{
		if (value.Format is not ("apple" or "FcmV1" or "windows" or "windowsphone" or "adm" or "baidu" or "browser" or "template") || value.Target is not ("tags" or "broadcast") || value.Body is null || Encoding.UTF8.GetByteCount(value.Body) > 65536 || value.Parameters is null || value.Headers is null || value.Headers.Count > 12 || value.Parameters.Count > 100)
			throw Invalid();
		if (value.Target == "broadcast")
		{
			if (value.TagExpression != "")
				throw Invalid();
		}
		else
			NotificationTagExpression.Validate(value.TagExpression);
		if (value.Format == "template")
		{
			if (value.Body != "" || value.Headers.Count != 0 || value.Parameters.Count == 0 || value.Parameters.Any(p => p.Name is null || p.Value is null || p.Name.Length is < 1 or > 128 || p.Name.Any(char.IsControl) || p.Value.Length > 65536) || value.Parameters.Select(p => p.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() != value.Parameters.Count || Encoding.UTF8.GetByteCount(value.Payload()) > 65536)
				throw Invalid();
		}
		else
		{
			if (value.Parameters.Count != 0 || string.IsNullOrWhiteSpace(value.Body))
				throw Invalid();
			if (value.Format is "apple" or "FcmV1" or "adm" or "baidu" or "browser")
			{
				try
				{
					using var json = JsonDocument.Parse(value.Body, new JsonDocumentOptions { MaxDepth = 32 });
					if (json.RootElement.ValueKind != JsonValueKind.Object || (value.Format == "apple" && (!json.RootElement.TryGetProperty("aps", out var aps) || aps.ValueKind != JsonValueKind.Object)) || (value.Format == "FcmV1" && (!json.RootElement.TryGetProperty("message", out var message) || message.ValueKind != JsonValueKind.Object)))
						throw Invalid();
				}
				catch (JsonException)
				{
					throw Invalid();
				}
			}
		}

		var allowed = value.Format switch
		{
			"apple" => new[]
			{
				"apns-push-type",
				"apns-priority",
				"apns-expiration",
				"apns-collapse-id",
				"apns-topic",
				"ServiceBusNotification-Apns-Expiry"
			},
			"windows" => new[]
			{
				"X-WNS-Type",
				"X-WNS-TTL",
				"X-WNS-Cache-Policy",
				"X-WNS-Tag",
				"X-WNS-SuppressPopup"
			},
			"windowsphone" => new[]
			{
				"X-WindowsPhone-Target",
				"X-NotificationClass"
			},
			"baidu" => new[]
			{
				"X-Baidu-Message-Type"
			},
			_ => Array.Empty<string>()
		};
		if (value.Headers.Select(h => h.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() != value.Headers.Count || value.Headers.Any(h => h.Name is null || h.Value is null || !allowed.Contains(h.Name, StringComparer.OrdinalIgnoreCase) || h.Value.Length is < 1 or > 512 || h.Value.Any(c => c < 32 || c > 126)))
			throw Invalid();
		string? Header(string name) => value.Headers.FirstOrDefault(h => h.Name.Equals(name, StringComparison.OrdinalIgnoreCase))?.Value;
		if (value.Format == "windows")
		{
			var kind = Header("X-WNS-Type");
			if (kind is not ("wns/toast" or "wns/tile" or "wns/badge" or "wns/raw"))
				throw Invalid();
			if (kind != "wns/raw")
			{
				var xml = ParseXml(value.Body);
				if (xml.Name.LocalName != kind[4..])
					throw Invalid();
			}
		}

		if (value.Format == "windowsphone")
		{
			if (Header("X-NotificationClass") is not ("1" or "2" or "3") || Header("X-WindowsPhone-Target") is not (null or "toast" or "token"))
				throw Invalid();
			if (Header("X-NotificationClass") != "3")
				ParseXml(value.Body);
		}

		if (Header("apns-priority") is { } priority && priority is not ("5" or "10"))
			throw Invalid();
		if (Header("apns-expiration") is { } expiry && !long.TryParse(expiry, out _))
			throw Invalid();
		if (Header("ServiceBusNotification-Apns-Expiry") is { } date && !DateTimeOffset.TryParse(date, out _))
			throw Invalid();
		if (Header("X-Baidu-Message-Type") is { } type && type is not ("0" or "1"))
			throw Invalid();
	}

	private static System.Xml.Linq.XElement ParseXml(string body)
	{
		try
		{
			using var reader = System.Xml.XmlReader.Create(new StringReader(body), new System.Xml.XmlReaderSettings { DtdProcessing = System.Xml.DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 65536 });
			var xml = System.Xml.Linq.XDocument.Load(reader);
			if (xml.Root is null || xml.Descendants().Any(e => e.Ancestors().Take(33).Count() > 32))
				throw Invalid();
			return xml.Root;
		}
		catch (System.Xml.XmlException)
		{
			throw Invalid();
		}
	}

	public static string Payload(this NotificationDraft value) => value.Format == "template" ? JsonSerializer.Serialize(value.Parameters.ToDictionary(p => p.Name, p => p.Value), new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }) : value.Body;
	private static OperationException Invalid() => new(OperationFailure.InvalidInput, "Review the notification: use a valid native payload or unique string template parameters, supported platform headers and a payload no larger than 64 KiB UTF-8.");
}
