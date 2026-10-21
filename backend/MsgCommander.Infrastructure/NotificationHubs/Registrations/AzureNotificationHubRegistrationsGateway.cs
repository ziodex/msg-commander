using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace MsgCommander.Infrastructure.NotificationHubs.Registrations;
// Bounded data-plane adapter. Fixed endpoint, no redirects or retries; Atom XML is retained for unknown PNS fields.
public sealed class AzureNotificationHubRegistrationsGatewayFactory : INotificationHubRegistrationsGatewayFactory
{
	public INotificationHubRegistrationsGateway Create(ConnectionProfile profile, string hubName) => new AzureNotificationHubRegistrationsGateway(profile, hubName);
}

public sealed partial class AzureNotificationHubRegistrationsGateway : INotificationHubRegistrationsGateway
{
	private readonly HttpClient http;
	private readonly string hubPath, keyName, key, host;
	public AzureNotificationHubRegistrationsGateway(ConnectionProfile profile, string hubName) : this(profile, hubName, new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, MaxResponseHeadersLength = 16, ConnectTimeout = TimeSpan.FromSeconds(10) })
	{
	}

	internal AzureNotificationHubRegistrationsGateway(ConnectionProfile profile, string hubName, HttpMessageHandler transport)
	{
		new NotificationHubScope("hub", hubName).Validate();
		var parts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
		foreach (var part in (profile.Secret ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
		{
			var at = part.IndexOf('=');
			if (at < 1 || !parts.TryAdd(part[..at].Trim(), part[(at + 1)..].Trim()))
				throw InvalidConnection();
		}

		if (profile.Service != "notification-hubs" || profile.Auth != "sas" || parts.Keys.Any(k => !new[] { "Endpoint", "SharedAccessKeyName", "SharedAccessKey", "EntityPath" }.Contains(k, StringComparer.OrdinalIgnoreCase)) || !parts.TryGetValue("Endpoint", out var endpoint) || !Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "sb" || !uri.IsDefaultPort || uri.AbsolutePath != "/" || uri.Query != "" || uri.Fragment != "" || uri.UserInfo != "" || !System.Text.RegularExpressions.Regex.IsMatch(profile.Namespace ?? "", @"^[a-z][a-z0-9-]{0,49}\.servicebus\.windows\.net$", System.Text.RegularExpressions.RegexOptions.IgnoreCase) || !string.Equals(uri.Host, profile.Namespace, StringComparison.OrdinalIgnoreCase) || !parts.TryGetValue("SharedAccessKeyName", out var name) || name.Length is < 1 or > 256 || name.Any(char.IsControl) || !parts.TryGetValue("SharedAccessKey", out var secret) || secret.Length is < 1 or > 4096 || secret.Any(char.IsControl) || (parts.TryGetValue("EntityPath", out var entity) && entity != hubName))
			throw InvalidConnection();
		host = profile.Namespace!;
		hubPath = string.Join('/', hubName.Split('/').Select(Uri.EscapeDataString));
		keyName = name;
		key = secret;
		http = new(transport)
		{
			Timeout = Timeout.InfiniteTimeSpan
		};
	}

	private static OperationException InvalidConnection() => new(OperationFailure.InvalidInput, "Use a Notification Hubs SAS key connection string matching the profile namespace and selected hub. Signed-token strings are not supported.");
	internal static string Sign(string audience, string name, string key, long expiry)
	{
		var resource = Uri.EscapeDataString(audience.ToLowerInvariant()).ToLowerInvariant();
		var signature = Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes(key), Encoding.UTF8.GetBytes(resource + "\n" + expiry.ToString(System.Globalization.CultureInfo.InvariantCulture))));
		return $"SharedAccessSignature sr={resource}&sig={Uri.EscapeDataString(signature)}&se={expiry}&skn={Uri.EscapeDataString(name)}";
	}

	public async Task<NotificationHubRegistrationGatewayPage> QueryAsync(NotificationHubRegistrationQuery query, string? continuation, CancellationToken cancellation)
	{
		query.Validate();
		if (continuation is not null && (continuation.Length > 16384 || continuation.Any(char.IsControl)))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid registration continuation token.");
		var path = query.Mode == "tag" ? $"tags/{Uri.EscapeDataString(query.Value)}/registrations" : "registrations";
		var parameters = $"api-version=2015-01&$top={query.PageSize}";
		if (query.Mode == "handle")
		{
			var field = query.HandleKind == "apns" ? "DeviceToken" : "ChannelUri";
			var value = query.HandleKind == "apns" ? query.Value.ToUpperInvariant() : query.Value;
			parameters += "&$filter=" + Uri.EscapeDataString(field + " eq '" + value.Replace("'", "''", StringComparison.Ordinal) + "'");
		}

		if (continuation is not null)
			parameters += "&ContinuationToken=" + Uri.EscapeDataString(continuation);
		using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
		deadline.CancelAfter(TimeSpan.FromSeconds(30));
		try
		{
			using var request = new HttpRequestMessage(HttpMethod.Get, $"https://{host}/{hubPath}/{path}?{parameters}");
			request.Headers.TryAddWithoutValidation("Authorization", Sign($"https://{host}/{hubPath}", keyName, key, DateTimeOffset.UtcNow.AddMinutes(10).ToUnixTimeSeconds()));
			request.Headers.TryAddWithoutValidation("x-ms-version", "2015-01");
			request.Headers.TryAddWithoutValidation("Accept", "application/atom+xml");
			using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
			if (response.StatusCode != HttpStatusCode.OK)
				throw new OperationException(OperationFailure.TransportUnavailable, response.StatusCode switch
				{
					HttpStatusCode.Unauthorized => "Notification Hubs registration access denied. Check the SAS key and Manage rights for this hub.",
					HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests => "Notification Hubs rejected or throttled this registration query. Check Manage rights and quotas, then retry explicitly.",
					HttpStatusCode.NotFound => "The hub or registration query was not found. Check the hub name and selected tag.",
					HttpStatusCode.BadRequest => "Notification Hubs rejected this registration query. Check the tag or device handle format.",
					_ => "Notification Hubs registration query failed. Check connectivity and retry explicitly. Nothing was retried."
				});
			const int limit = 2 * 1024 * 1024;
			if (response.Content.Headers.ContentLength > limit)
				throw Limit();
			await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
			using var buffer = new MemoryStream();
			var chunk = new byte[8192];
			int size;
			while ((size = await stream.ReadAsync(chunk, deadline.Token)) > 0)
			{
				if (buffer.Length + size > limit)
					throw Limit();
				await buffer.WriteAsync(chunk.AsMemory(0, size), deadline.Token);
			}

			buffer.Position = 0;
			using var reader = XmlReader.Create(buffer, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = limit });
			var document = XDocument.Load(reader, LoadOptions.None);
			XNamespace atom = "http://www.w3.org/2005/Atom", service = "http://schemas.microsoft.com/netservices/2010/10/servicebus/connect";
			if (document.Root?.Name != atom + "feed" || document.Descendants().Any(e => e.Ancestors().Take(33).Count() > 32))
				throw InvalidFeed();
			var entries = document.Root.Elements(atom + "entry").ToArray();
			if (entries.Length > query.PageSize)
				throw Limit();
			var captured = MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow);
			var items = new List<NotificationHubRegistrationDetails>();
			foreach (var entry in entries)
			{
				deadline.Token.ThrowIfCancellationRequested();
				var content = entry.Element(atom + "content");
				var description = content?.Elements().SingleOrDefault();
				if (description is null || description.Elements().GroupBy(e => e.Name).Any(g => g.Count() > 1) || description.Name.Namespace != service || !description.Name.LocalName.EndsWith("RegistrationDescription", StringComparison.Ordinal))
					throw InvalidFeed();
				string? Field(string name) => description.Element(service + name)?.Value;
				var id = Field("RegistrationId");
				var kind = description.Name.LocalName;
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
				var tags = (Field("Tags") ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
				var raw = description.ToString();
				var body = Field("BodyTemplate");
				var etag = Field("ETag") ?? entry.Attributes().FirstOrDefault(a => a.Name.LocalName == "etag")?.Value;
				var expiration = Field("ExpirationTime");
				if (string.IsNullOrWhiteSpace(id) || id.Length > 256 || kind.Length > 128 || handle?.Length > 4096 || tags.Length > 256 || tags.Any(t => t.Length > 256) || etag?.Length > 512 || expiration?.Length > 128 || raw.Length > 131072 || Encoding.UTF8.GetByteCount(raw) > 131072 || body?.Length > 131072)
					throw Limit();
				var platform = kind.StartsWith("Apple", StringComparison.Ordinal) ? "APNS" : kind.StartsWith("FcmV1", StringComparison.Ordinal) ? "FCM v1" : kind.StartsWith("Fcm", StringComparison.Ordinal) ? "FCM" : kind.StartsWith("Gcm", StringComparison.Ordinal) ? "GCM (legacy)" : kind.StartsWith("Windows", StringComparison.Ordinal) ? "WNS" : kind.StartsWith("Mpns", StringComparison.Ordinal) ? "MPNS" : kind.StartsWith("Adm", StringComparison.Ordinal) ? "ADM" : kind.StartsWith("Baidu", StringComparison.Ordinal) ? "Baidu" : kind.StartsWith("Browser", StringComparison.Ordinal) ? "Browser" : "Unknown";
				var details = new NotificationHubRegistrationDetails(new(Guid.NewGuid().ToString(), id, kind, platform, kind.Contains("Template", StringComparison.Ordinal), expiration, tags, handle), captured, etag, body, raw, platform == "Unknown" ? "Unknown registration type. Inspect the original XML for all fields." : null);
				if (System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(details, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)).Length > 786432)
					throw Limit();
				items.Add(details);
			}

			if (items.Select(i => i.Registration.RegistrationId).Distinct(StringComparer.Ordinal).Count() != items.Count)
				throw InvalidFeed();
			var tokens = response.Headers.TryGetValues("X-MS-ContinuationToken", out var values) ? values.ToArray() : [];
			if (tokens.Length > 1 || tokens.Any(t => t.Length > 16384 || t.Any(char.IsControl)))
				throw InvalidFeed();
			return new(items, tokens.FirstOrDefault() is { Length: > 0 } next ? next : null);
		}
		catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
		{
			throw new OperationException(OperationFailure.TransportUnavailable, "Registration query timed out after 30 seconds. Retry explicitly.");
		}
		catch (XmlException)
		{
			throw InvalidFeed();
		}
		catch (HttpRequestException)
		{
			throw new OperationException(OperationFailure.TransportUnavailable, "Registration query could not reach Notification Hubs. Check connectivity and retry explicitly.");
		}
		catch (InvalidOperationException)
		{
			throw InvalidFeed();
		}
	}

	private static OperationException Limit() => new(OperationFailure.OperationBlocked, "Registration response exceeds the local display limit. Reduce the page size or narrow the query; no partial page was displayed.");
	private static OperationException InvalidFeed() => new(OperationFailure.TransportUnavailable, "Notification Hubs returned an invalid registration feed. No partial page was displayed.");
	public ValueTask DisposeAsync()
	{
		http.Dispose();
		return ValueTask.CompletedTask;
	}
}
