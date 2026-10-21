using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.NotificationHubs.Connections;
using MsgCommander.Application.NotificationHubs.Gateways;
using MsgCommander.Contracts.NotificationHubs.Registrations;

namespace MsgCommander.Application.NotificationHubs.Registrations;

public sealed class RegistrationBrowsingService(IRegistrationCatalogGateway gateway, NotificationHubRegistrationsConnection connection, RegistrationSnapshotStore snapshots, INotificationHubManagementAccess management)
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	private readonly Dictionary<string, (NotificationHubRegistrationQuery Query, string Token, IReadOnlyList<string> Ancestors)> cursors = [];
	public void Clear() => cursors.Clear();
	public NotificationHubRegistrationDetails Inspect(string? id) => snapshots.Get(id);
	public async Task<NotificationHubRegistrationDetails> ReloadAsync(string? id, CancellationToken cancellation)
	{
		var original = snapshots.Get(id);
		var fresh = await gateway.GetAsync(original.Registration.RegistrationId, cancellation);
		cancellation.ThrowIfCancellationRequested();
		snapshots.Remember(fresh);
		return snapshots.Get(fresh.Registration.SnapshotId);
	}

	public async Task<NotificationHubRegistrationsPage> QueryAsync(NotificationHubRegistrationQuery query, string? cursor, CancellationToken cancellation)
	{
		query.Validate();
		string? token = null;
		IReadOnlyList<string> ancestors = [];
		if (cursor is not null)
		{
			if (!cursors.TryGetValue(cursor, out var saved) || saved.Query != query)
				throw new OperationException(OperationFailure.InvalidInput, "Registration cursor expired or belongs to another query.");
			token = saved.Token;
			ancestors = saved.Ancestors;
		}

		if (cursor is not null && cursors.Count >= 250)
			throw new OperationException(OperationFailure.OperationBlocked, "Registration page limit reached. Start a new query to continue browsing.");
		var page = await gateway.QueryAsync(query, token, cancellation);
		if (page.Items.Count > query.PageSize || JsonSerializer.SerializeToUtf8Bytes(page.Items.Select(i => i.Registration), Json).Length > 393216)
			throw new OperationException(OperationFailure.OperationBlocked, "Registration summaries exceed the display limit. Reduce page size; no partial page was displayed.");
		if (page.ContinuationToken is { } repeated && (repeated == token || ancestors.Contains(repeated)))
			throw new OperationException(OperationFailure.TransportUnavailable, "Notification Hubs repeated a registration continuation token. Start a fresh query; no partial page was displayed.");
		if (connection.ManagementConnectionId is { } admin)
			await management.RequireAsync(admin, connection.ProfileId, cancellation);
		cancellation.ThrowIfCancellationRequested();
		if (cursor is null)
			cursors.Clear();
		var next = page.ContinuationToken is null ? null : Guid.NewGuid().ToString();
		if (next is not null)
			cursors.Add(next, (query, page.ContinuationToken!, token is null ? [] : Array.AsReadOnly(ancestors.Append(token).ToArray())));
		snapshots.RememberPage(page.Items);
		return new(Array.AsReadOnly(page.Items.Select(i => RegistrationSnapshotStore.Freeze(i).Registration).ToArray()), next, page.Items.FirstOrDefault()?.CapturedAt ?? DateTimeOffset.UtcNow.ToString("O"));
	}
}
