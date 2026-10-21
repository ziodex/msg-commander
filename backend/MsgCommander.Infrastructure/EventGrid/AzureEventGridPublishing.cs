using System.Net.Http.Headers;
using Azure;
using Azure.Core;
namespace MsgCommander.Infrastructure.EventGrid;

public sealed partial class AzureEventGridGateway
{
	public const string PublishingApiVersion = "2024-06-01";
	private TokenCredential? publishingCredential;
	private HttpClient? publishingHttp;
	private string? publishingHost;
	public async Task PublishAsync(string topic, string mode, byte[] body, Action dispatch, CancellationToken cancellation)
	{
		if (!EventGridAddress.IsName(topic) || mode is not ("single" or "batch") || body.Length is < 1 or > 1048576)
			throw new OperationException(OperationFailure.InvalidInput, "Invalid CloudEvents request.");
		if (publishingCredential is null || publishingHttp is null || publishingHost is null)
			throw new OperationException(OperationFailure.AuthenticationRequired, "Reconnect Event Grid to enable publishing.");
		var access = await publishingCredential.GetTokenAsync(new TokenRequestContext(["https://eventgrid.azure.net/.default"]), cancellation);
		using var request = new HttpRequestMessage(HttpMethod.Post, new Uri("https://" + publishingHost + "/topics/" + Uri.EscapeDataString(topic) + ":publish?" + (mode == "batch" ? "_overload=publishCloudEvents&" : "") + "api-version=" + PublishingApiVersion));
		request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access.Token);
		request.Content = new ByteArrayContent(body);
		request.Content.Headers.ContentType = new MediaTypeHeaderValue(mode == "batch" ? "application/cloudevents-batch+json" : "application/cloudevents+json") { CharSet = "utf-8" };
		cancellation.ThrowIfCancellationRequested();
		dispatch();
		using var response = await publishingHttp.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
		// The documented 200 response is the publishing acknowledgment. Do not read a body or follow redirects.
		if (response.StatusCode != System.Net.HttpStatusCode.OK)
			throw new RequestFailedException((int)response.StatusCode, "Event Grid publishing did not return the documented acknowledgment.");
	}
}
