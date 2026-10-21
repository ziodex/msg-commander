using System.Net;
using System.Text;
using System.Xml.Linq;
using MsgCommander.Host;

sealed class NotificationHubJobsWire : HttpMessageHandler
{
	static readonly XNamespace A = "http://www.w3.org/2005/Atom", S = "http://schemas.microsoft.com/netservices/2010/10/servicebus/connect", D = "http://schemas.microsoft.com/2003/10/Serialization/Arrays";
	public readonly List<(string Method, Uri Uri, string? Body)> Requests = [];
	public HttpStatusCode? Status
	{
		get; set;
	}
	public bool LoseResponse
	{
		get; set;
	}
	public bool Slow
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
	public int Count { get; set; } = 1;
	public bool HasNext
	{
		get; set;
	}
	public bool RelativeFiles
	{
		get; set;
	}
	private readonly Dictionary<string, XElement> jobs = [];
	public static string Sas(bool output = true) => $"https://fixturestore.blob.core.windows.net/registrations{(output ? "" : "/input.txt")}?sv=2025-01-05&sr={(output ? "c" : "b")}&sp={(output ? "rwl" : "r")}&se={Uri.EscapeDataString(DateTimeOffset.UtcNow.AddDays(1).ToString("O"))}&spr=https&sig=SECRET-STORAGE-SAS";
	static XElement Entry(string id, string type, string status, string output, string? input = null) => new(A + "entry", new XElement(A + "content", new XAttribute("type", "application/xml"), new XElement(S + "NotificationHubJob",
		new XElement(S + "JobId", id), new XElement(S + "Progress", status == "Completed" ? "100" : "25.5"), new XElement(S + "Type", type), new XElement(S + "Status", status), new XElement(S + "OutputContainerUri", output), input is null ? null : new XElement(S + "ImportFileUri", input), new XElement(S + "Failure", "SECRET service failure https://fixturestore.blob.core.windows.net/private?sig=SECRET"), new XElement(S + "OutputProperties", new XElement(D + "KeyValueOfstringstring", new XElement(D + "Key", "OutputFilePath"), new XElement(D + "Value", Sas() + "&file=SECRET")), new XElement(D + "KeyValueOfstringstring", new XElement(D + "Key", "FailedFilePath"), new XElement(D + "Value", "https://evil.invalid/?sig=SECRET"))), new XElement(S + "CreatedAt", "2026-10-19T09:00:00Z"), new XElement(S + "UpdatedAt", "2026-10-19T09:01:00Z"))));
	public async Task<HttpResponseMessage> Respond(HttpRequestMessage request, CancellationToken cancellation)
	{
		var uri = request.RequestUri!;
		if (uri.Scheme != "https" || uri.Host != "fixture.servicebus.windows.net" || uri.Query != "?api-version=2020-06" || request.Headers.GetValues("x-ms-version").Single() != "2020-06" || !request.Headers.GetValues("Authorization").Single().StartsWith("SharedAccessSignature "))
			throw new Exception("Bulk jobs escaped fixed route or authentication/version");
		var parts = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
		if (parts.Length is < 2 or > 3 || parts[1] != "jobs")
			throw new Exception("Wrong jobs route");
		var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellation);
		Requests.Add((request.Method.Method, uri, body));
		if (Status is not null || parts[0] == "job-denied")
			return new(Status ?? HttpStatusCode.Forbidden)
			{
				Content = new StringContent("SECRET-AZURE-ERROR")
			};
		if (!jobs.ContainsKey("existing-job"))
			jobs.Add("existing-job", Entry("existing-job", "ExportRegistrations", "Completed", Sas()));
		if (request.Method == HttpMethod.Post)
		{
			if (parts.Length != 2)
				throw new Exception("POST must target job collection");
			var root = XElement.Parse(body!).Element(A + "content")!.Element(S + "NotificationHubJob")!;
			if (!root.Elements().Select(e => e.Name.LocalName).SequenceEqual(root.Element(S + "ImportFileUri") is null ? new[] { "Type", "OutputContainerUri" } : new[] { "Type", "OutputContainerUri", "ImportFileUri" }))
				throw new Exception("Job XML data-contract order/fields incorrect");
			var id = "job-" + jobs.Count;
			var entry = Entry(id, root.Element(S + "Type")!.Value, "Running", root.Element(S + "OutputContainerUri")!.Value, root.Element(S + "ImportFileUri")?.Value);
			jobs.Add(id, entry);
			if (Slow || parts[0] == "job-slow")
				await Task.Delay(10000, cancellation);
			if (LoseResponse || parts[0] == "job-uncertain")
				throw new HttpRequestException("SECRET-LOST-JOB-ACK");
			var response = new HttpResponseMessage(HttpStatusCode.Created) { Content = new StringContent(XmlOverride ?? entry.ToString(), Encoding.UTF8, "application/atom+xml") };
			OnAcknowledged?.Invoke();
			return response;
		}
		if (request.Method != HttpMethod.Get)
			throw new Exception("Unsupported jobs method");
		if (parts.Length == 3)
		{
			if (!jobs.TryGetValue(parts[2], out var entry))
				return new(HttpStatusCode.NotFound);
			var root = entry.Element(A + "content")!.Element(S + "NotificationHubJob")!;
			root.Element(S + "Status")!.Value = "Completed";
			root.Element(S + "Progress")!.Value = "100";
			if (RelativeFiles)
				root.Element(S + "OutputProperties")!.Elements().First().Elements(D + "Value").Single().Value = "/alerts/" + parts[2] + "/Output.txt?sig=SECRET";
			return new(HttpStatusCode.OK)
			{
				Content = new StringContent(XmlOverride ?? entry.ToString(), Encoding.UTF8, "application/atom+xml")
			};
		}
		var entries = Count == 1 ? jobs.Values.ToArray() : Enumerable.Range(0, Count).Select(i => Entry("listed-" + i, "ExportRegistrations", "Completed", Sas())).ToArray();
		var feed = new XElement(A + "feed", entries, HasNext ? new XElement(A + "link", new XAttribute("rel", "next"), new XAttribute("href", "https://evil.invalid/?sig=SECRET")) : null);
		return new(HttpStatusCode.OK)
		{
			Content = new StringContent(XmlOverride ?? feed.ToString(), Encoding.UTF8, "application/atom+xml")
		};
	}
	protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation) => Respond(request, cancellation);
}
