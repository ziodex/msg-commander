using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.EventGrid.Gateways;
using MsgCommander.Contracts.EventGrid.Browsing;
using MsgCommander.Contracts.EventGrid.Administration;

namespace MsgCommander.Application.EventGrid.Browsing;

/// <summary>Owns opaque, parent-scoped browse cursors for one connection generation.</summary>
public sealed class EventGridBrowsingService(IEventGridGateway gateway)
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	private readonly Dictionary<string, (EventGridTarget Parent, string Token, IReadOnlyList<string> Ancestors)> cursors = [];
	public void Clear() => cursors.Clear();
	public async Task<EventGridAdminDetails> AdminGetAsync(EventGridTarget target, CancellationToken cancellation)
	{
		target.Validate();
		if (target.Kind == "namespace")
			throw new OperationException(OperationFailure.InvalidInput, "Choose a topic or subscription.");
		var result = await gateway.AdminGetAsync(target, cancellation);
		if (JsonSerializer.SerializeToUtf8Bytes(result, Json).Length > 786432)
			throw new OperationException(OperationFailure.OperationBlocked, "Event Grid editor metadata exceeds the display limit.");
		return result;
	}
	public async Task<EventGridDetails> InspectAsync(EventGridTarget target, CancellationToken cancellation)
	{
		target.Validate();
		var result = await gateway.GetAsync(target, cancellation);
		if (JsonSerializer.SerializeToUtf8Bytes(result, Json).Length > 786432)
			throw new OperationException(OperationFailure.OperationBlocked, "Event Grid inspection exceeds the display limit.");
		cancellation.ThrowIfCancellationRequested();
		return result;
	}
	public async Task<EventGridPage> ListAsync(EventGridTarget target, string? cursor, CancellationToken cancellation)
	{
		target.Validate();
		if (target.Kind == "subscription")
			throw new OperationException(OperationFailure.InvalidInput, "List topics or subscriptions from their parent.");
		string? token = null;
		IReadOnlyList<string> ancestors = [];
		if (cursor is not null)
		{
			if (!cursors.TryGetValue(cursor, out var saved) || saved.Parent != target)
				throw new OperationException(OperationFailure.InvalidInput, "Event Grid cursor expired or belongs to another parent.");
			token = saved.Token;
			ancestors = saved.Ancestors;
		}
		if (cursors.Count >= 1000)
			throw new OperationException(OperationFailure.OperationBlocked, "Event Grid page limit reached. Reconnect to continue browsing.");
		var page = await gateway.ListAsync(target, token, cancellation);
		if (page.Items.Count > 250 || JsonSerializer.SerializeToUtf8Bytes(page.Items, Json).Length > 524288)
			throw new OperationException(OperationFailure.OperationBlocked, "Event Grid page exceeds the display limit.");
		if (page.ContinuationToken is { } repeated && (repeated == token || ancestors.Contains(repeated)))
			throw new OperationException(OperationFailure.OperationBlocked, "Azure repeated an Event Grid continuation. Refresh this parent; no partial page was displayed.");
		cancellation.ThrowIfCancellationRequested();
		if (cursor is null)
			foreach (var key in cursors.Where(pair => pair.Value.Parent == target).Select(pair => pair.Key).ToArray())
				cursors.Remove(key);
		var next = page.ContinuationToken is null ? null : Guid.NewGuid().ToString();
		if (next is not null)
			cursors.Add(next, (target, page.ContinuationToken!, token is null ? [] : [.. ancestors, token]));
		return page with
		{
			ContinuationToken = next
		};
	}
}
