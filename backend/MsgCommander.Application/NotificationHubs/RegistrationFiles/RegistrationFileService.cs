using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.NotificationHubs.Connections;
using MsgCommander.Application.NotificationHubs.Registrations;
using MsgCommander.Contracts.NotificationHubs.RegistrationFiles;
using MsgCommander.Contracts.NotificationHubs.Registrations;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Application.NotificationHubs.RegistrationFiles;

public sealed class RegistrationFileService(NotificationHubRegistrationsConnection connection, RegistrationSnapshotStore snapshots, RegistrationAdministrationService administration, IRegistrationFileCodec codec, INotificationHubManagementAccess management, TimeProvider clock)
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	private sealed record FilePlan(RegistrationFilePreview Preview, IReadOnlyDictionary<string, PreparedRegistrationEntry> Content, DateTimeOffset ExpiresAt);
	private FilePlan? review;
	private readonly OperationReceipts<RegistrationFileResult> receipts = new(20, "Registration import operation ID belongs to another request.", "Registration import receipt limit reached. Review results before reconnecting.");
	public void Clear()
	{
		review = null;
		receipts.Clear();
	}

	public RegistrationFileResult? GetResult(string id) => receipts.Get(id);
	public RegistrationFileEncoded Export(IReadOnlyList<string> ids, string? format, CancellationToken cancellation)
	{
		if (ids is null || ids.Count is < 1 or > 100 || ids.Any(i => !Guid.TryParse(i, out _)) || ids.Distinct().Count() != ids.Count || format is not ("json" or "xml"))
			throw new OperationException(OperationFailure.InvalidInput, "Choose distinct current registration snapshots and JSON or XML.");
		var records = ids.Select(id =>
		{
			cancellation.ThrowIfCancellationRequested();
			var details = snapshots.Get(id);
			return new RegistrationFileRecord(details.Registration.RegistrationId, details.Etag, details.CapturedAt, details.RawXml);
		}).ToArray();
		var archive = new RegistrationFileArchive(codec.Format, 1, Timestamp(clock.GetUtcNow()), connection.Namespace, connection.HubName, records);
		var bytes = codec.Encode(archive, format);
		cancellation.ThrowIfCancellationRequested();
		return new(Convert.ToBase64String(bytes), records.Length);
	}

	public RegistrationFilePreview Preview(Func<string> readContent, CancellationToken cancellation)
	{
		review = null;
		var decoded = codec.Decode(readContent(), cancellation);
		var entries = new List<RegistrationFileEntry>();
		var contents = new Dictionary<string, PreparedRegistrationEntry>();
		foreach (var content in decoded.Entries)
		{
			cancellation.ThrowIfCancellationRequested();
			var id = Guid.NewGuid().ToString();
			var frozen = content with
			{
				Tags = Array.AsReadOnly(content.Tags.ToArray()),
				Draft = content.Draft is { } draft ? draft with
				{
					Tags = Array.AsReadOnly(draft.Tags.ToArray())
				}

				: null
			};
			entries.Add(new(id, frozen.RegistrationId, frozen.Kind, frozen.Platform, frozen.Template, frozen.Tags, frozen.Handle, frozen.Issue is null ? "create" : "blocked", frozen.Issue));
			contents.Add(id, frozen);
		}

		var expires = clock.GetUtcNow().AddMinutes(10);
		var preview = new RegistrationFilePreview(Guid.NewGuid().ToString(), decoded.SourceNamespace, decoded.SourceHub, connection.Namespace, connection.HubName, Timestamp(expires), entries.AsReadOnly(), Array.AsReadOnly(new[] { "Creates new Azure registration IDs only. Source IDs, ETags and expiration are retained in exports but excluded from writes. Existing registrations are never updated or deleted.", "No destination deduplication is performed. Importing the same device handle can create duplicate registrations; review the selected definitions before applying.", "Files contain device handles, tags, templates and extension fields. Connection strings, SAS keys and hub provider credentials are not included. XML Atom links are never followed." }));
		if (JsonSerializer.SerializeToUtf8Bytes(preview, Json).Length > 786432)
			throw new OperationException(OperationFailure.OperationBlocked, "Registration preview exceeds the display limit. Split the file into smaller imports.");
		cancellation.ThrowIfCancellationRequested();
		review = new(preview, contents, expires);
		return preview;
	}

	public RegistrationFileDefinition Inspect(string? importId, string? entryId)
	{
		if (review is null || review.Preview.ImportId != importId || review.ExpiresAt < clock.GetUtcNow() || !review.Content.TryGetValue(entryId ?? "", out var content))
			throw new OperationException(OperationFailure.InvalidInput, "Registration file preview expired. Choose the file again.");
		var value = new RegistrationFileDefinition(entryId!, content.RawXml, content.Tags);
		if (JsonSerializer.SerializeToUtf8Bytes(value, Json).Length > 786432)
			throw new OperationException(OperationFailure.OperationBlocked, "Registration definition exceeds the inspection limit.");
		return value;
	}

	public async Task<RegistrationFileResult> ApplyAsync(RegistrationFileApply request, string stamp, Func<RegistrationFileProgress, Task> emit, CancellationToken cancellation)
	{
		if (!request.Acknowledge || !Guid.TryParse(request.ImportId, out _) || request.EntryIds is null || request.EntryIds.Count is < 1 or > 100 || request.EntryIds.Any(i => !Guid.TryParse(i, out _)) || request.EntryIds.Distinct().Count() != request.EntryIds.Count)
			throw new OperationException(OperationFailure.InvalidInput, "Select distinct registration entries and acknowledge the destination and new-ID/duplicate behavior.");
		if (receipts.CheckRequest(request.Id, stamp) is { } prior)
			return prior;
		var plan = review;
		if (plan is null || plan.Preview.ImportId != request.ImportId || plan.ExpiresAt < clock.GetUtcNow())
			throw new OperationException(OperationFailure.InvalidInput, "Registration file preview expired or was already used. Choose the file again.");
		if (request.EntryIds.Any(id => !plan.Content.TryGetValue(id, out var item) || item.Draft is null))
			throw new OperationException(OperationFailure.InvalidInput, "A selected registration is blocked or unavailable.");
		var selected = plan.Preview.Entries.Where(e => request.EntryIds.Contains(e.Id)).ToArray();
		review = null;
		var steps = selected.Select(e => new RegistrationFileStep(e.Id, "not-attempted", null)).ToArray();
		var status = "completed";
		using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
		deadline.CancelAfter(TimeSpan.FromMinutes(2));
		var token = deadline.Token;
		for (var i = 0; i < selected.Length; i++)
		{
			if (token.IsCancellationRequested)
			{
				status = "cancelled";
				break;
			}

			try
			{
				await emit(new(request.Id, i * 100 / selected.Length, $"Importing registrations: {i}/{selected.Length} confirmed."));
			}
			catch
			{
				status = "cancelled";
				break;
			}

			if (connection.ManagementConnectionId is { } admin)
			{
				try
				{
					await management.RequireAsync(admin, connection.ProfileId, token);
				}
				catch (Exception error) when (error is OperationException or OperationCanceledException)
				{
					status = token.IsCancellationRequested ? "cancelled" : "failed";
					break;
				}
			}

			var change = new NotificationHubRegistrationChange(Guid.NewGuid().ToString(), connection.ConnectionId, "create", null, plan.Content[selected[i].Id].Draft, true);
			var result = await administration.ApplyAsync(change, null, token);
			steps[i] = new(selected[i].Id, result.Status, result);
			if (result.Status != "confirmed")
			{
				status = result.Status;
				break;
			}
		}

		var confirmed = steps.Count(s => s.Status == "confirmed");
		var summary = $"{confirmed}/{steps.Length} registrations confirmed. " + (status == "completed" ? "Import completed with new Azure IDs." : status == "unknown" ? "Azure may have created a registration whose ID was lost. Check the retained receipt and destination before another import. Nothing was retried." : status == "cancelled" ? "Stopped at cancellation or the two-minute limit. Earlier confirmed copies remain applied." : "Stopped at the first failure. Earlier confirmed copies remain applied.");
		var receipt = new RegistrationFileResult(request.Id, status, summary, Array.AsReadOnly(steps));
		receipts.Add(request.Id, stamp, receipt);
		return receipt;
	}
}
