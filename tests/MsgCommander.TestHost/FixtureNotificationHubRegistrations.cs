using System.Net;
using System.Text;
using System.Xml.Linq;
using MsgCommander.Host;
sealed class FixtureNotificationHubRegistrationsFactory : INotificationHubRegistrationsGatewayFactory
{
	public INotificationHubRegistrationsGateway Create(ConnectionProfile profile, string hubName)
	{
		if (profile.Namespace != "fixture.servicebus.windows.net")
			throw new OperationException(OperationFailure.InvalidInput, "Offline registrations accept only the fixture namespace.");
		return new AzureNotificationHubRegistrationsGateway(profile, hubName, new NotificationHubRegistrationsWire());
	}
}
sealed class NotificationHubRegistrationsWire : HttpMessageHandler
{
	public List<(string Method, Uri Uri, string Authorization)> Requests { get; } = [];
	public string? XmlOverride
	{
		get; set;
	}
	public string? NextOverride
	{
		get; set;
	}
	public HttpStatusCode? StatusOverride
	{
		get; set;
	}
	public bool FailNextOnce
	{
		get; set;
	}
	public HttpStatusCode? WriteStatusOverride
	{
		get; set;
	}
	public bool ConflictNextWrite
	{
		get; set;
	}
	public bool LoseNextWriteResponse
	{
		get; set;
	}
	public bool SlowNextWrite
	{
		get; set;
	}
	public bool MalformedNextAck
	{
		get; set;
	}
	public bool MissingEtag
	{
		get; set;
	}
	public Action? OnWriteAcknowledged
	{
		get; set;
	}
	public List<(string Method, string? IfMatch, string? Body)> Writes { get; } = [];
	private readonly Dictionary<string, (XElement Root, int Version)> registrations = [];
	private int sequence;
	public NotificationHubRegistrationsWire()
	{
		foreach (var r in Data)
			registrations.Add(r.Id, (new XElement(Service + r.Kind, new XElement(Service + "Tags", r.Tags), new XElement(Service + r.Field, r.Handle), r.Body is null ? null : new XElement(Service + "BodyTemplate", new XCData(r.Body)), new XElement(Service + "FutureProperty", "<script>data only</script>"), r.Kind.StartsWith("Baidu") ? new XElement(Service + "BaiduChannelId", "baidu-channel") : null), 42));
	}
	public void Bump(string id)
	{
		var row = registrations[id];
		registrations[id] = (row.Root, row.Version + 1);
	}
	private XElement Entry(string id)
	{
		var row = registrations[id];
		var root = new XElement(row.Root);
		root.AddFirst(new XElement(Service + "ExpirationTime", "2027-01-01T00:00:00Z"));
		root.AddFirst(new XElement(Service + "RegistrationId", id));
		return new XElement(Atom + "entry", MissingEtag ? null : new XAttribute(XName.Get("etag", "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"), $"W/\"{row.Version}\""), new XElement(Atom + "content", new XAttribute("type", "application/xml"), root));
	}
	private HttpResponseMessage Single(string id)
	{
		var response = new HttpResponseMessage(HttpStatusCode.Created) { Content = new StringContent(Entry(id).ToString(), Encoding.UTF8, "application/atom+xml") };
		if (!MissingEtag)
			response.Headers.ETag = new System.Net.Http.Headers.EntityTagHeaderValue($"\"{registrations[id].Version}\"", true);
		return response;
	}

	private static readonly XNamespace Atom = "http://www.w3.org/2005/Atom", Service = "http://schemas.microsoft.com/netservices/2010/10/servicebus/connect";
	public static readonly string AppleToken = new('A', 64);
	public static readonly (string Id, string Kind, string Field, string Handle, string Tags, string? Body)[] Data = [
		("apple-native","AppleRegistrationDescription","DeviceToken",AppleToken,"sports,customer:123",null),
		("fcm-template","FcmV1TemplateRegistrationDescription","FcmV1RegistrationId","fcm-token-'quoted'&value=one","news,customer:123","{\"message\":{\"notification\":{\"title\":\"$(title)\",\"body\":\"$(message)\"}},\"enabled\":true,\"count\":42}"),
		("windows-native","WindowsRegistrationDescription","ChannelUri","https://push.example.invalid/channel?a=1&b=2","news",null),
		("baidu-native","BaiduRegistrationDescription","BaiduUserId","baidu-user","sports",null),
		("future-native","FutureRegistrationDescription","FutureHandle","future-token","future",null),
		("mpns-native","MpnsRegistrationDescription","ChannelUri","http://push.example.invalid/mpns","legacy",null),
		("adm-native","AdmRegistrationDescription","AdmRegistrationId","adm-token","legacy",null),
		("gcm-native","GcmRegistrationDescription","GcmRegistrationId","gcm-token","legacy",null),
		("fcm-native","FcmRegistrationDescription","FcmRegistrationId","fcm-token","android",null),
		("gcm-template","GcmTemplateRegistrationDescription","GcmRegistrationId","current-firebase-token","migrate-template","{\"notification\":{\"title\":\"$(title)\",\"body\":\"$(message)\"},\"data\":{\"source\":\"legacy\"}}"),
	];
	private readonly NotificationTestSendWire sender = new();
	private readonly NotificationHubJobsWire jobs = new();
	protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
	{
		var uri = request.RequestUri!;
		var authorization = request.Headers.GetValues("Authorization").Single();
		if (uri.Host != "fixture.servicebus.windows.net" || uri.Scheme != "https")
			throw new Exception("Escaped registration scope");
		Requests.Add((request.Method.Method, uri, authorization));
		if (uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).ElementAtOrDefault(1) == "jobs")
			return await jobs.Respond(request, cancellation);
		if (!authorization.StartsWith("SharedAccessSignature ") || request.Headers.GetValues("x-ms-version").Single() != "2015-01")
			throw new Exception("Missing SAS/version");
		var parameters = uri.Query.TrimStart('?').Split('&').Select(p => p.Split('=', 2)).ToDictionary(p => Uri.UnescapeDataString(p[0]), p => Uri.UnescapeDataString(p.ElementAtOrDefault(1) ?? ""));
		if (parameters["api-version"] != "2015-01")
			throw new Exception("Wrong registration API version");
		var hub = uri.AbsolutePath.Split('/')[1];
		if (uri.AbsolutePath.EndsWith("/messages/"))
			return await sender.Respond(request, cancellation);
		MissingEtag = MissingEtag || hub == "no-etag";
		var path = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
		if (request.Method != HttpMethod.Get)
		{
			if (path.Length is < 2 or > 3 || path[1] != "registrations")
				throw new Exception("Wrong write route");
			var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellation);
			var match = request.Headers.TryGetValues("If-Match", out var matches) ? matches.Single() : null;
			Writes.Add((request.Method.Method, match, body));
			if (WriteStatusOverride is { } denied || hub == "write-denied")
				return new(WriteStatusOverride ?? HttpStatusCode.Unauthorized)
				{
					Content = new StringContent("SECRET-WRITE-ERROR")
				};
			if (SlowNextWrite || hub == "write-slow")
			{
				SlowNextWrite = false;
				await Task.Delay(10000, cancellation);
			}
			var id = path.Length == 3 ? Uri.UnescapeDataString(path[2]) : null;
			if (request.Method == HttpMethod.Post)
			{
				if (id is not null || match is not null)
					throw new Exception("Create must POST to collection without If-Match");
				id = "created-" + (++sequence);
			}
			else
			{
				if (id is null || !registrations.ContainsKey(id))
					return new(HttpStatusCode.NotFound);
				if (ConflictNextWrite || (hub == "conflict" && !conflicted))
				{
					ConflictNextWrite = false;
					conflicted = true;
					Bump(id);
				}
				if (match != $"W/\"{registrations[id].Version}\"")
					return new(HttpStatusCode.PreconditionFailed)
					{
						Content = new StringContent("SECRET-ETAG-CONFLICT")
					};
			}
			if (request.Method == HttpMethod.Delete)
				registrations.Remove(id!);
			else
			{
				var root = XDocument.Parse(body!).Root!.Element(Atom + "content")!.Elements().Single();
				if (new[] { "RegistrationId", "ETag", "ExpirationTime" }.Any(n => root.Element(Service + n) is not null))
					throw new Exception("Read-only metadata sent");
				var version = registrations.TryGetValue(id!, out var old) ? old.Version + 1 : 1;
				registrations[id!] = (new XElement(root), version);
			}
			if (LoseNextWriteResponse || hub == "uncertain")
			{
				LoseNextWriteResponse = false;
				throw new HttpRequestException("SECRET-LOST-WRITE-ACK");
			}
			if (MalformedNextAck)
			{
				MalformedNextAck = false;
				return new(HttpStatusCode.Created)
				{
					Content = new StringContent("<invalid>")
				};
			}
			var accepted = request.Method == HttpMethod.Delete ? new HttpResponseMessage(HttpStatusCode.OK) : Single(id!);
			OnWriteAcknowledged?.Invoke();
			return accepted;
		}
		if (path.Length == 3 && path[1] == "registrations")
		{
			var id = Uri.UnescapeDataString(path[2]);
			return registrations.ContainsKey(id) ? Single(id) : new(HttpStatusCode.NotFound);
		}
		var tag = uri.AbsolutePath.Contains("/tags/") ? Uri.UnescapeDataString(uri.AbsolutePath.Split("/tags/")[1].Split('/')[0]) : null;
		if (hub == "slow" || tag == "slow")
			await Task.Delay(10000, cancellation);
		var status = StatusOverride ?? (hub == "denied" || tag == "denied" ? HttpStatusCode.Unauthorized : HttpStatusCode.OK);
		if (status != HttpStatusCode.OK)
			return new(status)
			{
				Content = new StringContent("SECRET-REGISTRATION-ERROR")
			};
		var rows = registrations.AsEnumerable();
		if (hub == "empty" || tag == "empty")
			rows = [];
		else if (tag is not null && tag is not ("slow" or "flaky"))
			rows = rows.Where(r => (r.Value.Root.Element(Service + "Tags")?.Value ?? "").Split(',').Contains(tag));
		if (parameters.TryGetValue("$filter", out var filter))
		{
			var prefix = filter.StartsWith("DeviceToken eq '") ? "DeviceToken eq '" : "ChannelUri eq '";
			if (!filter.StartsWith(prefix) || !filter.EndsWith('\''))
				throw new Exception("Incorrect OData filter");
			var value = filter[prefix.Length..^1].Replace("''", "'", StringComparison.Ordinal);
			rows = rows.Where(r => r.Value.Root.Elements().Any(e => new[] { "DeviceToken", "ChannelUri", "FcmV1RegistrationId", "FcmRegistrationId", "GcmRegistrationId", "AdmRegistrationId", "BaiduUserId" }.Contains(e.Name.LocalName) && e.Value == value));
		}
		var offset = 0;
		if (parameters.TryGetValue("ContinuationToken", out var cursor))
		{
			if (!cursor.StartsWith("opaque+/=&:"))
				throw new Exception("Cursor was not encoded correctly");
			offset = int.Parse(cursor.Split(':')[1]);
			if (FailNextOnce || (tag == "flaky" && failed == false))
			{
				FailNextOnce = false;
				failed = true;
				return new(HttpStatusCode.ServiceUnavailable)
				{
					Content = new StringContent("SECRET next-page error")
				};
			}
		}
		var all = rows.ToArray();
		var take = Math.Min(2, int.Parse(parameters["$top"]));
		var entries = all.Skip(offset).Take(take).Select(r => Entry(r.Key));
		var xml = XmlOverride ?? new XElement(Atom + "feed", entries).ToString();
		var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(xml, Encoding.UTF8, "application/atom+xml") };
		var next = NextOverride ?? (offset + take < all.Length ? $"opaque+/=&:{offset + take}" : null);
		if (next is not null)
			response.Headers.TryAddWithoutValidation("X-MS-ContinuationToken", next);
		return response;
	}
	private bool failed, conflicted;
}
