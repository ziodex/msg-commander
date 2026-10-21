using System.Globalization;
using System.Net;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace MsgCommander.Infrastructure.NotificationHubs.Registrations;

public sealed partial class AzureNotificationHubRegistrationsGateway
{
	private static readonly XNamespace JobAtom = "http://www.w3.org/2005/Atom", JobService = "http://schemas.microsoft.com/netservices/2010/10/servicebus/connect";
	public async Task<NotificationHubJobsPage> ListJobsAsync(CancellationToken cancellation)
	{
		var document = await JobRequest(HttpMethod.Get, null, null, null, null, cancellation);
		if (document.Root?.Name != JobAtom + "feed")
			throw InvalidJobs();
		var entries = document.Root.Elements(JobAtom + "entry").ToArray();
		if (entries.Length > 100)
			throw new OperationException(OperationFailure.OperationBlocked, "More than 100 bulk jobs were returned. Look up a specific Azure job ID instead.");
		var jobs = entries.Select(ParseJob).ToArray();
		if (jobs.Select(j => j.JobId).Distinct(StringComparer.Ordinal).Count() != jobs.Length)
			throw InvalidJobs();
		return new(jobs, MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow), document.Root.Elements(JobAtom + "link").Any(e => (string?)e.Attribute("rel") == "next"));
	}

	public async Task<NotificationHubJob> GetJobAsync(string jobId, CancellationToken cancellation)
	{
		NotificationHubJobDraftRules.ValidateJobId(jobId);
		var job = ParseJob((await JobRequest(HttpMethod.Get, jobId, null, null, null, cancellation)).Root!);
		if (job.JobId != jobId)
			throw InvalidJobs();
		return job;
	}

	public async Task<NotificationHubJob> SubmitJobAsync(NotificationHubJobDraft draft, Action dispatched, Action acknowledged, CancellationToken cancellation)
	{
		draft.Validate();
		var description = new XElement(JobService + "NotificationHubJob", new XElement(JobService + "Type", draft.Type), new XElement(JobService + "OutputContainerUri", draft.OutputContainerUri), draft.ImportFileUri is null ? null : new XElement(JobService + "ImportFileUri", draft.ImportFileUri));
		var body = new XElement(JobAtom + "entry", new XElement(JobAtom + "content", new XAttribute("type", "application/xml"), description)).ToString(SaveOptions.DisableFormatting);
		var job = ParseJob((await JobRequest(HttpMethod.Post, null, body, dispatched, acknowledged, cancellation)).Root!);
		if (job.Type != draft.Type)
			throw InvalidJobs();
		return job;
	}

	private async Task<XDocument> JobRequest(HttpMethod method, string? jobId, string? body, Action? dispatched, Action? acknowledged, CancellationToken cancellation)
	{
		using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
		deadline.CancelAfter(TimeSpan.FromSeconds(30));
		try
		{
			using var request = new HttpRequestMessage(method, $"https://{host}/{hubPath}/jobs{(jobId is null ? "" : "/" + Uri.EscapeDataString(jobId))}?api-version=2020-06");
			request.Headers.TryAddWithoutValidation("Authorization", Sign($"https://{host}/{hubPath}", keyName, key, DateTimeOffset.UtcNow.AddMinutes(10).ToUnixTimeSeconds()));
			request.Headers.TryAddWithoutValidation("x-ms-version", "2020-06");
			request.Headers.TryAddWithoutValidation("Accept", "application/atom+xml");
			if (body is not null)
				request.Content = new StringContent(body, Encoding.UTF8, "application/atom+xml");
			deadline.Token.ThrowIfCancellationRequested();
			dispatched?.Invoke();
			using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
			if (response.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.Created or HttpStatusCode.Accepted))
			{
				var message = response.StatusCode switch
				{
					HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => "Bulk job access denied. Check this hub's Manage rights, Standard tier and Storage SAS permissions.",
					HttpStatusCode.NotFound => "The hub or bulk job was not found. Check the hub name and Azure job ID.",
					HttpStatusCode.BadRequest => "Azure rejected the bulk job. Check Standard tier, job type, input format and Storage SAS access/expiry.",
					HttpStatusCode.TooManyRequests => "Azure throttled this bulk job request. Check existing jobs and retry explicitly later.",
					_ => "Bulk job request failed. Check Azure state and connectivity; nothing was retried."
				};
				if (method == HttpMethod.Post && (int)response.StatusCode is >= 400 and < 500 && response.StatusCode != HttpStatusCode.RequestTimeout)
					throw new NotificationHubJobRejectedException(message);
				throw new OperationException(OperationFailure.TransportUnavailable, message);
			}

			acknowledged?.Invoke();
			const int limit = 1024 * 1024;
			if (response.Content.Headers.ContentLength > limit)
				throw InvalidJobs();
			await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
			using var buffer = new MemoryStream();
			var chunk = new byte[8192];
			int count;
			while ((count = await stream.ReadAsync(chunk, deadline.Token)) > 0)
			{
				if (buffer.Length + count > limit)
					throw InvalidJobs();
				await buffer.WriteAsync(chunk.AsMemory(0, count), deadline.Token);
			}

			buffer.Position = 0;
			using var reader = XmlReader.Create(buffer, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = limit });
			var document = XDocument.Load(reader);
			if (document.Descendants().Any(e => e.Ancestors().Take(33).Count() > 32))
				throw InvalidJobs();
			return document;
		}
		catch (XmlException)
		{
			throw InvalidJobs();
		}
		catch (InvalidOperationException)
		{
			throw InvalidJobs();
		}
		catch (HttpRequestException)
		{
			throw new OperationException(OperationFailure.TransportUnavailable, "Bulk job request lost its connection. Check Azure job state before another submission; nothing was retried.");
		}
		catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
		{
			throw new OperationException(OperationFailure.TransportUnavailable, "Bulk job request timed out after 30 seconds. Check Azure job state before another submission.");
		}
	}

	private static NotificationHubJob ParseJob(XElement entry)
	{
		var contents = entry.Elements(JobAtom + "content").ToArray();
		var root = entry.Name == JobAtom + "entry" && contents.Length == 1 ? contents[0].Elements().SingleOrDefault() : null;
		if (root?.Name != JobService + "NotificationHubJob" || root.Elements().GroupBy(e => e.Name).Any(g => g.Count() > 1))
			throw InvalidJobs();
		string? Field(string name) => root.Element(JobService + name)?.Value;
		var id = Field("JobId");
		if (id is null || !System.Text.RegularExpressions.Regex.IsMatch(id, @"^[A-Za-z0-9_-]{1,128}$"))
			throw InvalidJobs();
		var type = Field("Type") ?? "Unknown";
		if (!NotificationHubJobDraftRules.Types.Contains(type))
			type = "Unknown";
		var status = Field("Status") ?? "Unknown";
		if (status is not ("Started" or "Running" or "Completed" or "Failed"))
			status = "Unknown";
		decimal? progress = decimal.TryParse(Field("Progress"), NumberStyles.Number, CultureInfo.InvariantCulture, out var number) && number is >= 0 and <= 100 ? number : null;
		string? Timestamp(string name) => DateTimeOffset.TryParse(Field(name), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var value) ? MsgCommander.Application.Common.DisplayValues.Timestamp(value) : null;
		string? Output(string key)
		{
			var properties = root.Element(JobService + "OutputProperties");
			// DataContract dictionaries use the arrays namespace and Key/Value child elements.
			var values = properties?.Elements().Where(p => p.Elements().Any(e => e.Name.LocalName == "Key" && e.Value == key)).ToArray() ?? [];
			if (values.Length != 1)
				return null;
			var value = values[0].Elements().SingleOrDefault(e => e.Name.LocalName == "Value")?.Value;
			var absolute = NotificationHubJobDraftRules.PublicLocation(value);
			if (absolute is not null)
				return absolute;
			var container = NotificationHubJobDraftRules.PublicLocation(Field("OutputContainerUri"));
			if (container is null || string.IsNullOrWhiteSpace(value) || value.Length > 4096 || value.Contains(':') || value.StartsWith("//", StringComparison.Ordinal) || value.Any(char.IsControl) || value.Contains('\\'))
				return null;
			var path = value.Split('?', 2)[0].Split('#', 2)[0].Trim('/');
			if (path.Split('/').Any(p => string.IsNullOrEmpty(p) || Uri.UnescapeDataString(p) is "." or ".."))
				return null;
			return NotificationHubJobDraftRules.PublicLocation(container.TrimEnd('/') + "/" + path);
		}

		return new(id, type, status, progress, Timestamp("CreatedAt"), Timestamp("UpdatedAt"), NotificationHubJobDraftRules.PublicLocation(Field("OutputContainerUri")), NotificationHubJobDraftRules.PublicLocation(Field("ImportFileUri")), Output("OutputFilePath"), Output("FailedFilePath"), !string.IsNullOrEmpty(Field("Failure")));
	}

	private static OperationException InvalidJobs() => new(OperationFailure.TransportUnavailable, "Azure returned an invalid or oversized bulk job response. Check the Azure job ID or refresh jobs; private service details were withheld.");
}
