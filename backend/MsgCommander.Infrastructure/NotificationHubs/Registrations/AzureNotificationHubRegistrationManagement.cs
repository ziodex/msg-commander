using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;

namespace MsgCommander.Infrastructure.NotificationHubs.Registrations;

public sealed partial class AzureNotificationHubRegistrationsGateway
{
	private HttpRequestMessage RegistrationRequest(HttpMethod method, string path)
	{
		var request = new HttpRequestMessage(method, $"https://{host}/{hubPath}/registrations{path}?api-version=2015-01");
		request.Headers.TryAddWithoutValidation("Authorization", Sign($"https://{host}/{hubPath}", keyName, key, DateTimeOffset.UtcNow.AddMinutes(10).ToUnixTimeSeconds()));
		request.Headers.TryAddWithoutValidation("x-ms-version", "2015-01");
		request.Headers.TryAddWithoutValidation("Accept", "application/atom+xml");
		return request;
	}

	private static string IdentityPath(string registrationId)
	{
		if (string.IsNullOrWhiteSpace(registrationId) || registrationId.Length > 256 || registrationId.Any(char.IsControl) || registrationId is "." or ".." || registrationId.Contains('/') || registrationId.Contains('\\'))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid registration ID.");
		return "/" + Uri.EscapeDataString(registrationId);
	}

	private static string Rejection(HttpStatusCode status) => status switch
	{
		HttpStatusCode.PreconditionFailed => "Registration changed in Azure (ETag conflict). Reload the current registration and review your changes before trying again.",
		HttpStatusCode.NotFound => "Registration no longer exists. Refresh the query; nothing was recreated.",
		HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => "Azure denied registration access. Check the SAS policy rights and selected hub.",
		HttpStatusCode.Conflict => "Azure rejected a conflicting registration change. Reload and review before trying again.",
		HttpStatusCode.TooManyRequests => "Azure throttled the registration change. Nothing was retried; retry explicitly after reviewing the result.",
		_ => "Azure rejected the registration definition. Check the handle, tags, template and platform fields. Nothing was retried."
	};
	private static async Task<NotificationHubRegistrationDetails> ReadEntry(HttpResponseMessage response, CancellationToken cancellation)
	{
		const int limit = 2 * 1024 * 1024;
		if (response.Content.Headers.ContentLength > limit)
			throw Limit();
		await using var stream = await response.Content.ReadAsStreamAsync(cancellation);
		using var buffer = new MemoryStream();
		var chunk = new byte[8192];
		int size;
		while ((size = await stream.ReadAsync(chunk, cancellation)) > 0)
		{
			if (buffer.Length + size > limit)
				throw Limit();
			buffer.Write(chunk, 0, size);
		}

		buffer.Position = 0;
		using var reader = XmlReader.Create(buffer, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = limit });
		var document = XDocument.Load(reader);
		var entry = document.Root;
		if (entry?.Name != RegistrationXml.Atom + "entry")
			throw InvalidFeed();
		var description = entry.Element(RegistrationXml.Atom + "content")?.Elements().SingleOrDefault();
		if (description is null)
			throw InvalidFeed();
		var root = RegistrationXml.Parse(description.ToString());
		string? Field(string n) => root.Element(RegistrationXml.Service + n)?.Value;
		var id = Field("RegistrationId");
		var kind = root.Name.LocalName;
		var tags = (Field("Tags") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
		var etag = response.Headers.ETag?.ToString() ?? Field("ETag") ?? entry.Attributes().FirstOrDefault(a => a.Name.LocalName == "etag")?.Value;
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
		}.Select(Field).FirstOrDefault(v => !string.IsNullOrEmpty(v));
		if (string.IsNullOrWhiteSpace(id) || id.Length > 256 || kind.Length > 128 || tags.Length > 256 || tags.Any(t => t.Length > 256) || etag?.Length > 512 || handle?.Length > 4096 || Field("ExpirationTime")?.Length > 128)
			throw Limit();
		IdentityPath(id);
		var prefix = kind.Replace("TemplateRegistrationDescription", "", StringComparison.Ordinal).Replace("RegistrationDescription", "", StringComparison.Ordinal);
		var platform = prefix switch
		{
			"Apple" => "APNS",
			"Windows" => "WNS",
			"Mpns" => "MPNS",
			"FcmV1" => "FCM v1",
			"Fcm" => "FCM",
			"Gcm" => "GCM (legacy)",
			"Adm" => "ADM",
			"Baidu" => "Baidu",
			"Browser" => "Browser",
			_ => "Unknown"
		};
		var details = new NotificationHubRegistrationDetails(new(Guid.NewGuid().ToString(), id, kind, platform, kind.Contains("Template", StringComparison.Ordinal), Field("ExpirationTime"), tags, handle), MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow), etag, Field("BodyTemplate"), root.ToString(), platform == "Unknown" ? "Unknown platform. Review the advanced XML before editing." : null);
		if (System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(details, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)).Length > 786432)
			throw Limit();
		return details;
	}

	public async Task<NotificationHubRegistrationDetails> GetAsync(string registrationId, CancellationToken cancellation)
	{
		using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
		deadline.CancelAfter(TimeSpan.FromSeconds(30));
		try
		{
			using var request = RegistrationRequest(HttpMethod.Get, IdentityPath(registrationId));
			using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
			if (response.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.Created))
				throw new OperationException(OperationFailure.TransportUnavailable, Rejection(response.StatusCode));
			var details = await ReadEntry(response, deadline.Token);
			if (details.Registration.RegistrationId != registrationId)
				throw InvalidFeed();
			return details;
		}
		catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
		{
			throw new OperationException(OperationFailure.TransportUnavailable, "Registration read timed out. Reload explicitly.");
		}
		catch (Exception e) when (e is XmlException or InvalidOperationException or HttpRequestException)
		{
			throw new OperationException(OperationFailure.TransportUnavailable, "Could not read the current registration. Check connectivity and reload explicitly.");
		}
	}

	public async Task<NotificationHubRegistrationDetails?> ChangeAsync(NotificationHubRegistrationChange change, NotificationHubRegistrationDetails? original, Action dispatched, CancellationToken cancellation)
	{
		change.Validate();
		var body = change.Draft is null ? null : RegistrationXml.Prepare(change.Draft, original);
		var path = change.Action == "create" ? "/" : IdentityPath(original!.Registration.RegistrationId);
		var etag = change.Action == "create" ? null : RegistrationXml.Etag(original!.Etag);
		using var request = RegistrationRequest(change.Action == "create" ? HttpMethod.Post : change.Action == "update" ? HttpMethod.Put : HttpMethod.Delete, path);
		if (etag is not null)
			request.Headers.TryAddWithoutValidation("If-Match", etag);
		if (body is not null)
			request.Content = new StringContent(new XElement(RegistrationXml.Atom + "entry", new XElement(RegistrationXml.Atom + "content", new XAttribute("type", "application/xml"), body)).ToString(), Encoding.UTF8, "application/atom+xml");
		if (request.Content is not null)
			request.Content.Headers.ContentType = System.Net.Http.Headers.MediaTypeHeaderValue.Parse("application/atom+xml;type=entry;charset=utf-8");
		using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
		deadline.CancelAfter(TimeSpan.FromSeconds(30));
		cancellation.ThrowIfCancellationRequested();
		dispatched();
		using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
		if ((int)response.StatusCode is 400 or 401 or 403 or 404 or 405 or 409 or 412 or 413 or 415 or 422 or 429)
			throw new RegistrationRejectedException(Rejection(response.StatusCode));
		if (change.Action == "delete")
		{
			if (response.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.NoContent))
				throw new HttpRequestException("Unacknowledged delete");
			return null;
		}

		if (response.StatusCode != HttpStatusCode.Created)
			throw new HttpRequestException("Unacknowledged registration write");
		// An acknowledged write stays confirmed if cancellation arrives while its small response is being read.
		using var ackDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
		var result = await ReadEntry(response, ackDeadline.Token);
		if (original is not null && result.Registration.RegistrationId != original.Registration.RegistrationId)
			throw InvalidFeed();
		return result;
	}
}
