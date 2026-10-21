using System.Net.Http.Headers;
using System.Text.Json;
using Azure;
using Azure.Core;
namespace MsgCommander.Infrastructure.EventGrid;

public sealed partial class AzureEventGridGateway
{
	private readonly object leaseIssuer = new();
	public async Task<EventGridReceiveBatch> ReceiveAsync(EventGridTarget target, int maxEvents, int maxWait, Action dispatch, CancellationToken cancellation) =>
		EventGridPullResponses.Receive(await PullAsync(target, "receive", maxEvents, maxWait, 0, [], dispatch, cancellation), maxEvents, leaseIssuer);
	public async Task<EventGridSettlementBatch> SettleAsync(EventGridTarget target, string action, int delay, IReadOnlyList<EventGridLockToken> tokens, Action dispatch, CancellationToken cancellation) =>
		EventGridPullResponses.Settlement(await PullAsync(target, action, 1, 10, delay, tokens.Select(token => token.ForTransport(leaseIssuer)).ToArray(), dispatch, cancellation), leaseIssuer);
	private async Task<JsonElement> PullAsync(EventGridTarget target, string action, int maxEvents, int maxWait, int delay, IReadOnlyList<string> tokens, Action dispatch, CancellationToken cancellation)
	{
		target.Validate();
		if (target.Kind != "subscription" || action is not ("receive" or "acknowledge" or "release" or "reject" or "renewLock") || maxEvents is < 1 or > 10 || maxWait is < 10 or > 120 || !new[] { 0, 10, 60, 600, 3600 }.Contains(delay) || (action == "receive" ? tokens.Count != 0 : tokens.Count is < 1 or > 100))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid Event Grid pull request.");
		if (publishingCredential is null || publishingHttp is null || publishingHost is null)
			throw new OperationException(OperationFailure.AuthenticationRequired, "Reconnect Event Grid to enable pull delivery.");
		var access = await publishingCredential.GetTokenAsync(new TokenRequestContext(["https://eventgrid.azure.net/.default"]), cancellation);
		var query = "?api-version=" + PublishingApiVersion + (action == "receive" ? $"&maxEvents={maxEvents}&maxWaitTime={maxWait}" : action == "release" ? $"&releaseDelayInSeconds={delay}" : "");
		using var request = new HttpRequestMessage(HttpMethod.Post, new Uri("https://" + publishingHost + "/topics/" + Uri.EscapeDataString(target.TopicName!) + "/eventsubscriptions/" + Uri.EscapeDataString(target.SubscriptionName!) + ":" + action + query));
		request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", access.Token);
		request.Content = new ByteArrayContent(action == "receive" ? "{}"u8.ToArray() : JsonSerializer.SerializeToUtf8Bytes(new
		{
			lockTokens = tokens
		}));
		request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
		cancellation.ThrowIfCancellationRequested();
		dispatch();
		using var response = await publishingHttp.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation);
		if (response.StatusCode != System.Net.HttpStatusCode.OK)
			throw new RequestFailedException((int)response.StatusCode, "Event Grid pull operation did not return its documented result.");
		// Bound network/body processing independently; preserve a complete acknowledged response
		// if user cancellation arrives after it. No redirects or automatic retries.
		using var bodyTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
		using var stream = await response.Content.ReadAsStreamAsync(bodyTimeout.Token);
		using var output = new MemoryStream();
		var buffer = new byte[16384];
		var limit = action == "receive" ? 16 * 1024 * 1024 : 262144;
		while (true)
		{
			var count = await stream.ReadAsync(buffer, bodyTimeout.Token);
			if (count == 0)
				break;
			if (output.Length + count > limit)
				throw new IOException("Pull response exceeds local limit.");
			output.Write(buffer, 0, count);
		}
		using var doc = JsonDocument.Parse(output.ToArray(), new()
		{
			MaxDepth = 64
		});
		static void Unique(JsonElement node)
		{
			if (node.ValueKind == JsonValueKind.Object)
			{
				var names = new HashSet<string>();
				foreach (var p in node.EnumerateObject())
				{
					if (!names.Add(p.Name))
						throw new IOException("Ambiguous pull response.");
					Unique(p.Value);
				}
			}
			else if (node.ValueKind == JsonValueKind.Array)
				foreach (var child in node.EnumerateArray())
					Unique(child);
		}
		Unique(doc.RootElement);
		return doc.RootElement.Clone();
	}
}
