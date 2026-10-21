using System.Text;
using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.Relay.Gateways;
using MsgCommander.Application.Relay.Management;
using MsgCommander.Contracts.Relay.Management;
using MsgCommander.Contracts.Relay.Configuration;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Application.Relay.Management;

public sealed class RelayBrowsingService(IRelayGateway gateway)
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	private readonly Dictionary<string, (RelayScope Scope, string Kind, string Token)> cursors = [];
	public void Clear() => cursors.Clear();
	public async Task<RelayPage> ListAsync(RelayScope scope, string kind, string? cursor, CancellationToken cancellation)
	{
		scope.Validate();
		if (kind is not ("hybrid" or "wcf" or "policies") || (kind != "policies" && scope.Kind != "namespace"))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid Relay list scope.");
		string? token = null;
		if (cursor is not null)
		{
			if (!cursors.TryGetValue(cursor, out var saved) || saved.Scope != scope || saved.Kind != kind)
				throw new OperationException(OperationFailure.InvalidInput, "Relay cursor expired or belongs to another scope.");
			token = saved.Token;
		}

		if (cursors.Count >= 1000)
			throw new OperationException(OperationFailure.OperationBlocked, "Relay cursor limit reached. Reconnect after reviewing results.");
		var page = await gateway!.ListAsync(scope, kind, token, cancellation);
		if (page.Items.Count > 250 || JsonSerializer.SerializeToUtf8Bytes(page.Items, Json).Length > 524288)
			throw new OperationException(OperationFailure.OperationBlocked, "Relay page exceeds the local display limit.");
		var next = page.ContinuationToken is null ? null : Guid.NewGuid().ToString();
		if (next is not null)
			cursors.Add(next, (scope, kind, page.ContinuationToken!));
		return page with
		{
			ContinuationToken = next
		};
	}
}
