using System.Net;
using System.Text;
using System.Xml.Linq;
using MsgCommander.Host;
sealed class NotificationTestSendWire : HttpMessageHandler
{
	public List<(Uri Uri, string Body, string Format, string? Tags, string ContentType, IReadOnlyDictionary<string, string> Headers)> Sent { get; } = [];
	public HttpStatusCode? Status
	{
		get; set;
	}
	public string? XmlOverride
	{
		get; set;
	}
	public Action? OnAcknowledged
	{
		get; set;
	}
	public bool LoseResponse
	{
		get; set;
	}
	public string? Location
	{
		get; set;
	}
	protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation) => Respond(request, cancellation);
	internal async Task<HttpResponseMessage> Respond(HttpRequestMessage request, CancellationToken cancellation)
	{
		var uri = request.RequestUri!;
		if (uri.Scheme != "https" || uri.Host != "fixture.servicebus.windows.net" || !uri.IsDefaultPort || !uri.AbsolutePath.EndsWith("/messages/") || uri.Query != "?api-version=2015-01&test" || request.Method != HttpMethod.Post || !request.Headers.GetValues("Authorization").Single().StartsWith("SharedAccessSignature ") || request.Headers.GetValues("x-ms-version").Single() != "2015-01")
			throw new Exception("Escaped send scope");
		var body = await request.Content!.ReadAsStringAsync(cancellation);
		var format = request.Headers.GetValues("ServiceBusNotification-Format").Single();
		var tags = request.Headers.TryGetValues("ServiceBusNotification-Tags", out var values) ? values.Single() : null;
		Sent.Add((uri, body, format, tags, request.Content.Headers.ContentType!.MediaType!, request.Headers.ToDictionary(h => h.Key, h => string.Join(',', h.Value), StringComparer.OrdinalIgnoreCase)));
		var hub = uri.AbsolutePath.Split('/')[1];
		if (hub == "send-slow")
			await Task.Delay(10000, cancellation);
		if (Status is not null || hub == "send-denied")
			return new(Status ?? HttpStatusCode.Forbidden)
			{
				Content = new StringContent("SECRET-PNS-ERROR")
			};
		if (LoseResponse || hub == "send-uncertain")
			throw new HttpRequestException("SECRET-LOST-SEND-ACK");
		XNamespace ns = "http://schemas.microsoft.com/netservices/2010/10/servicebus/connect";
		var rows = new[] { ("apple", "apple-native", "apple-token", new HashSet<string> { "sports", "customer:123" }), ("FcmV1", "fcm-template", "fcm-token", new HashSet<string> { "news", "customer:123" }), ("apple", "apple-failed", "expired-token", new HashSet<string> { "sports", "muted" }) }.Where(r => (format == "template" || r.Item1 == format) && (tags is null || NotificationTagExpression.Matches(tags, r.Item4))).Take(10).ToArray();
		var failed = rows.Count(r => r.Item2 == "apple-failed");
		var xml = new XElement(ns + "NotificationOutcome", new XElement(ns + "Success", rows.Length - failed), new XElement(ns + "Failure", failed), new XElement(ns + "Results", rows.Select(r => new XElement(ns + "RegistrationResult", new XElement(ns + "ApplicationPlatform", r.Item1), new XElement(ns + "PnsHandle", r.Item3), new XElement(ns + "RegistrationId", r.Item2), new XElement(ns + "Outcome", r.Item2 == "apple-failed" ? "InvalidToken" : "Success")))));
		var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(XmlOverride ?? (hub == "send-malformed" ? "<invalid>" : xml.ToString()), Encoding.UTF8, "application/xml") };
		response.Headers.Location = new Uri(Location ?? $"https://fixture.servicebus.windows.net/{hub}/messages/notification-123?api-version=2015-04");
		OnAcknowledged?.Invoke();
		return response;
	}
}
