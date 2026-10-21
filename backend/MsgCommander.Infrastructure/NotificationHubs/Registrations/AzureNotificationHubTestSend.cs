using System.Net;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace MsgCommander.Infrastructure.NotificationHubs.Registrations;

public sealed partial class AzureNotificationHubRegistrationsGateway
{
	public async Task<NotificationSendDetails> TestSendAsync(NotificationDraft draft, Action dispatched, CancellationToken cancellation)
	{
		draft.Validate();
		var tracking = Guid.NewGuid().ToString();
		using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
		deadline.CancelAfter(TimeSpan.FromSeconds(30));
		using var request = new HttpRequestMessage(HttpMethod.Post, $"https://{host}/{hubPath}/messages/?api-version=2015-01&test");
		request.Headers.TryAddWithoutValidation("Authorization", Sign($"https://{host}/{hubPath}", keyName, key, DateTimeOffset.UtcNow.AddMinutes(10).ToUnixTimeSeconds()));
		request.Headers.TryAddWithoutValidation("x-ms-version", "2015-01");
		request.Headers.Add("TrackingId", tracking);
		request.Headers.Add("ServiceBusNotification-Format", draft.Format);
		if (draft.Target == "tags")
			request.Headers.Add("ServiceBusNotification-Tags", draft.TagExpression);
		foreach (var header in draft.Headers)
			request.Headers.Add(header.Name, header.Value);
		var contentType = draft.Format switch
		{
			"windows" when draft.Headers.Any(h => h.Name.Equals("X-WNS-Type", StringComparison.OrdinalIgnoreCase) && h.Value == "wns/raw") => "application/octet-stream",
			"windows" or "windowsphone" => "application/xml",
			_ => "application/json"
		};
		request.Content = new StringContent(draft.Payload(), Encoding.UTF8, contentType);
		cancellation.ThrowIfCancellationRequested();
		dispatched();
		using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
		var code = (int)response.StatusCode;
		if (response.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.Created))
		{
			if (code is 400 or 401 or 403 or 404 or 405 or 409 or 412 or 413 or 415 or 422 or 429)
				throw new NotificationSendRejectedException($"Azure rejected the test send (HTTP {code}). Check Send rights, hub provider credentials, target expression, payload and quotas. Nothing was retried.");
			throw new HttpRequestException("Test send acknowledgement unavailable.");
		}

		// A received acknowledgement remains confirmed even if cancellation or result parsing follows it.
		string? notificationId = null;
		var location = response.Headers.Location;
		if (location is not null && location.IsAbsoluteUri && location.Scheme == "https" && location.Host.Equals(host, StringComparison.OrdinalIgnoreCase) && location.IsDefaultPort && location.UserInfo == "" && location.Fragment == "" && location.AbsolutePath.StartsWith($"/{hubPath}/messages/", StringComparison.Ordinal))
		{
			var candidate = location.AbsolutePath[($"/{hubPath}/messages/").Length..];
			if (candidate.Length is > 0 and <= 256 && candidate.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
				notificationId = candidate;
		}

		string? raw = null;
		try
		{
			const int limit = 131072;
			using var readDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
			if (response.Content.Headers.ContentLength > limit)
				throw new InvalidDataException();
			await using var stream = await response.Content.ReadAsStreamAsync(readDeadline.Token);
			using var bytes = new MemoryStream();
			var buffer = new byte[8192];
			int size;
			while ((size = await stream.ReadAsync(buffer, readDeadline.Token)) > 0)
			{
				if (bytes.Length + size > limit)
					throw new InvalidDataException();
				bytes.Write(buffer, 0, size);
			}

			raw = new UTF8Encoding(false, true).GetString(bytes.ToArray());
			using var reader = XmlReader.Create(new StringReader(raw), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = limit });
			var xml = XDocument.Load(reader);
			XNamespace ns = "http://schemas.microsoft.com/netservices/2010/10/servicebus/connect";
			if (xml.Root?.Name != ns + "NotificationOutcome" || xml.Descendants().Any(e => e.Ancestors().Take(33).Count() > 32) || xml.Root.Elements().GroupBy(e => e.Name).Any(g => g.Count() > 1))
				throw new InvalidDataException();
			int Count(string name)
			{
				if (!int.TryParse(xml.Root.Element(ns + name)?.Value, out var n) || n < 0 || n > 1000000)
					throw new InvalidDataException();
				return n;
			}

			var success = Count("Success");
			var failure = Count("Failure");
			var results = xml.Root.Element(ns + "Results") ?? throw new InvalidDataException();
			var rows = results.Elements().ToArray();
			if (rows.Length > 100 || rows.Any(e => e.Name != ns + "RegistrationResult" || e.Elements().GroupBy(p => p.Name).Any(g => g.Count() > 1)))
				throw new InvalidDataException();
			string Field(XElement row, string name)
			{
				var value = row.Element(ns + name)?.Value ?? "";
				if (value.Length > 4096)
					throw new InvalidDataException();
				return value;
			}

			var details = new NotificationSendDetails(success, failure, rows.Select(r => new NotificationDeviceResult(Field(r, "ApplicationPlatform"), Field(r, "PnsHandle"), Field(r, "RegistrationId"), Field(r, "Outcome"))).ToArray(), tracking, notificationId, raw, null);
			if (System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(details, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)).Length > 262144)
				throw new InvalidDataException();
			return details;
		}
		catch (Exception)
		{
			return new(null, null, [], tracking, notificationId, null, "Azure acknowledged the test send, but detailed outcomes were unavailable or exceeded the local display bounds. Do not resend just to obtain results; device delivery is unverified.");
		}
	}
}
