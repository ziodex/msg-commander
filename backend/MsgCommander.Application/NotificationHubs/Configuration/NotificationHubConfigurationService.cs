using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.NotificationHubs.Gateways;
using MsgCommander.Application.NotificationHubs.Management;
using MsgCommander.Contracts.NotificationHubs.Management;
using MsgCommander.Contracts.NotificationHubs.Configuration;
namespace MsgCommander.Application.NotificationHubs.Configuration;

public sealed class NotificationHubConfigurationService(INotificationHubGateway gateway, NotificationHubConnection connection, NotificationHubAdministrationService administration, INotificationHubFailureClassifier failures, TimeProvider? timeProvider = null)
{
	private DateTimeOffset Now => (timeProvider ?? TimeProvider.System).GetUtcNow();
	public void Clear()
	{
		configPreview = null;
		configResults.Clear();
	}
	public NotificationHubConfigResult? GetResult(string id) => configResults.TryGetValue(id, out var prior) ? prior.Result : null;
	private sealed record ConfigPlan(NotificationHubConfigPreview Preview, IReadOnlyDictionary<string, NotificationHubChange> Changes, DateTimeOffset ExpiresAt);
	private ConfigPlan? configPreview;
	private readonly Dictionary<string, (string Stamp, NotificationHubConfigResult Result)> configResults = [];
	private static CancellationTokenSource ConfigDeadline(CancellationToken cancellation)
	{
		var source = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
		source.CancelAfter(TimeSpan.FromMinutes(2));
		return source;
	}
	private async Task<IReadOnlyList<NotificationHubItem>> AllConfigItems(NotificationHubScope scope, string kind, CancellationToken cancellation)
	{
		var items = new List<NotificationHubItem>();
		var seen = new HashSet<string>();
		string? token = null;
		do
		{
			cancellation.ThrowIfCancellationRequested();
			var page = await gateway!.ListAsync(scope, kind, token, cancellation);
			items.AddRange(page.Items);
			if (items.Count > 100 || (page.ContinuationToken is not null && !seen.Add(page.ContinuationToken)))
				throw new OperationException(OperationFailure.OperationBlocked, "Configuration listing exceeds 100 targets or repeated a continuation. Export a smaller scope.");
			token = page.ContinuationToken;
		} while (token is not null);
		return items;
	}
	public async Task<NotificationHubConfigExport> ExportAsync(NotificationHubScope scope, string? format, CancellationToken cancellation)
	{
		using var deadline = ConfigDeadline(cancellation);
		cancellation = deadline.Token;
		scope.Validate();
		if (format != "json")
			throw new OperationException(OperationFailure.InvalidInput, "Use Commander Notification Hubs JSON.");
		var scopes = new List<NotificationHubScope>();
		var warnings = new List<string> { "SAS keys, provider credentials, registrations and installations are excluded. New policies receive Azure-generated keys; existing policy keys and provider credentials are preserved." };
		if (scope.Kind == "namespace")
			scopes.AddRange((await AllConfigItems(scope, "hubs", cancellation)).Select(i => i.Target.Scope));
		else
			scopes.Add(scope);
		var total = scopes.Count;
		async Task<IReadOnlyList<NotificationHubConfigPolicy>> Policies(NotificationHubScope parent)
		{
			var policies = await AllConfigItems(parent, "policies", cancellation);
			total += policies.Count;
			if (total > 100)
				throw new OperationException(OperationFailure.OperationBlocked, "Configuration exceeds 100 resources/policies. Export a smaller scope.");
			return policies.Select(p => new NotificationHubConfigPolicy(p.Target.PolicyName!, p.Rights!)).ToArray();
		}
		List<NotificationHubConfigResource> resources = [];
		foreach (var selected in scopes)
		{
			var details = await gateway!.GetAsync(new(selected, null), cancellation);
			if (details.Warning is not null && !warnings.Contains(details.Warning))
				warnings.Add(details.Warning);
			if (details.Settings is null)
				throw new OperationException(OperationFailure.InvalidInput, "A selected hub has unrepresentable settings. Export a different scope; no partial file was saved.");
			resources.Add(new(selected.Name, details.Settings, await Policies(selected), true));
		}
		var namespacePolicies = scope.Kind == "namespace" ? await Policies(scope) : [];
		var archive = new NotificationHubConfigArchive(NotificationHubConfiguration.Format, 1, MsgCommander.Application.Common.DisplayValues.Timestamp(Now), connection!.Namespace, resources, namespacePolicies, warnings);
		var bytes = NotificationHubConfiguration.Encode(archive, format!);
		return new(Convert.ToBase64String(bytes), resources.Count + namespacePolicies.Count + resources.Sum(r => r.Policies.Count), warnings);
	}
	public async Task<NotificationHubConfigPreview> PreviewAsync(Func<NotificationHubConfigArchive> readArchive, CancellationToken cancellation)
	{
		configPreview = null;
		using var deadline = ConfigDeadline(cancellation);
		cancellation = deadline.Token;
		var archive = readArchive();
		var entries = new List<NotificationHubConfigEntry>();
		var changes = new Dictionary<string, NotificationHubChange>();
		async Task Add(NotificationHubTarget target, NotificationHubSettings? settings, IReadOnlyList<string>? rights, string? issue = null, bool replaceTags = true)
		{
			NotificationHubDetails? current = null;
			try
			{
				current = await gateway!.GetAsync(target, cancellation);
			}
			catch (Exception error) when (failures.Classify(error).NotFound) { }
			var action = current is null ? "create" : "update";
			if (current?.Warning is not null && current.Settings is null && target.PolicyName is null)
				issue = "Existing settings cannot be represented. Manage this resource separately.";
			if (!replaceTags && settings is not null)
				settings = settings with
				{
					Tags = current?.Settings?.Tags ?? []
				};
			if (target.Scope.Kind == "namespace" && string.Equals(target.PolicyName, "RootManageSharedAccessKey", StringComparison.OrdinalIgnoreCase) && rights?.Contains("Manage") != true)
				issue = "Keep the namespace root policy and its Manage rights.";
			var id = Guid.NewGuid().ToString();
			entries.Add(new(id, target, issue is null ? action : "blocked", settings, rights, current?.Settings, current?.Rights, issue));
			if (issue is null)
				changes.Add(id, new(Guid.NewGuid().ToString(), connection!.ConnectionId, target, action, current?.Revision, settings, rights, null, true));
		}
		foreach (var resource in archive.Resources)
		{
			var scope = new NotificationHubScope("hub", resource.Name);
			var issue = resource.Settings is null ? "Hub settings are missing or incomplete. This resource and its policies are blocked." : null;
			await Add(new(scope, null), resource.Settings, null, issue, resource.ReplaceTags);
			var parentIssue = entries[^1].Issue;
			foreach (var p in resource.Policies)
				await Add(new(scope, p.Name), null, p.Rights, parentIssue);
		}
		foreach (var p in archive.NamespacePolicies)
			await Add(new(new("namespace", ""), p.Name), null, p.Rights);
		var expires = Now.AddMinutes(10);
		var preview = new NotificationHubConfigPreview(Guid.NewGuid().ToString(), archive.SourceNamespace, connection!.Namespace, MsgCommander.Application.Common.DisplayValues.Timestamp(expires), entries, archive.Warnings);
		cancellation.ThrowIfCancellationRequested();
		configPreview = new(preview, changes, expires);
		return preview;
	}
	public async Task<NotificationHubConfigResult> ApplyAsync(NotificationHubConfigApply request, string stamp, Func<NotificationHubConfigProgress, Task> emit, CancellationToken cancellation)
	{
		if (!request.Acknowledged || !Guid.TryParse(request.ImportId, out _) || request.EntryIds is null || request.EntryIds.Count is < 1 or > 100 || request.EntryIds.Distinct().Count() != request.EntryIds.Count)
			throw new OperationException(OperationFailure.InvalidInput, "Select distinct import entries and acknowledge the destination and changes.");
		if (configResults.TryGetValue(request.Id, out var prior))
		{
			if (prior.Stamp != stamp)
				throw new OperationException(OperationFailure.InvalidInput, "Import operation ID belongs to another request.");
			return prior.Result;
		}
		if (configResults.Count >= 20)
			throw new OperationException(OperationFailure.OperationBlocked, "NotificationHub import receipt limit reached. Review results before reconnecting.");
		var plan = configPreview;
		if (plan is null || plan.Preview.ImportId != request.ImportId || plan.ExpiresAt < Now)
			throw new OperationException(OperationFailure.InvalidInput, "Configuration preview expired or was already used. Select the file again.");
		if (request.EntryIds.Any(id => !plan.Changes.ContainsKey(id)))
			throw new OperationException(OperationFailure.InvalidInput, "A selected import entry is unavailable or blocked.");
		var selected = plan.Preview.Entries.Where(e => request.EntryIds.Contains(e.Id)).ToArray();
		foreach (var policy in selected.Where(e => e.Target.PolicyName is not null && e.Target.Scope.Kind != "namespace"))
		{
			var parent = plan.Preview.Entries.Single(e => e.Target.Scope == policy.Target.Scope && e.Target.PolicyName is null);
			if (parent.Action == "create" && !request.EntryIds.Contains(parent.Id))
				throw new OperationException(OperationFailure.InvalidInput, "Include the new parent resource before importing its policies.");
		}
		configPreview = null; // Consume before the first write; further imports require a fresh review.
		var steps = selected.Select(e => new NotificationHubConfigStep(e.Target, "not-attempted", null)).ToArray();
		var status = "completed";
		using var deadline = ConfigDeadline(cancellation);
		var token = deadline.Token;
		for (var index = 0; index < selected.Length; index++)
		{
			if (token.IsCancellationRequested)
			{
				status = "cancelled";
				break;
			}
			try
			{
				await emit(new NotificationHubConfigProgress(request.Id, index * 100 / selected.Length, $"Importing Notification Hubs configuration: {index}/{selected.Length} targets confirmed."));
			}
			catch { status = "cancelled"; break; }
			var change = plan.Changes[selected[index].Id];
			change.Validate();
			var receipt = await administration.ApplyAsync(change, token);
			steps[index] = new(receipt.Target, receipt.Status, receipt);
			if (receipt.Status != "confirmed")
			{
				status = receipt.Status;
				break;
			}
		}
		var confirmed = steps.Count(s => s.Status == "confirmed");
		var summary = $"{confirmed}/{steps.Length} targets confirmed. " + (status == "completed" ? "Configuration import completed." : status == "unknown" ? "A write may have been accepted. Review Azure state before another change. Nothing was retried." : status == "cancelled" ? "Stopped at cancellation or the two-minute limit. Earlier confirmed writes remain applied." : "Stopped at the first failed target. Earlier confirmed writes remain applied.");
		var result = new NotificationHubConfigResult(request.Id, status, summary, steps);
		configResults.Add(request.Id, (stamp, result));
		return result;
	}
}
