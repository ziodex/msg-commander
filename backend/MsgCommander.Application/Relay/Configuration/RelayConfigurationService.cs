using System.Text;
using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.Relay.Gateways;
using MsgCommander.Application.Relay.Management;
using MsgCommander.Contracts.Relay.Management;
using MsgCommander.Contracts.Relay.Configuration;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Application.Relay.Configuration;

public sealed class RelayConfigurationService(IRelayGateway gateway, RelayConnection connection, RelayAdministrationService administration, IRelayFailureClassifier failures, TimeProvider clock)
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	public void Clear()
	{
		configPreview = null;
		receipts.Clear();
	}

	public RelayConfigResult? GetResult(string id) => receipts.Get(id);
	private sealed record ConfigPlan(RelayConfigPreview Preview, IReadOnlyDictionary<string, RelayChange> Changes, DateTimeOffset ExpiresAt);
	private ConfigPlan? configPreview;
	private readonly OperationReceipts<RelayConfigResult> receipts = new(20, "Import operation ID belongs to another request.", "Relay import receipt limit reached. Review results before reconnecting.");
	private static CancellationTokenSource ConfigDeadline(CancellationToken cancellation)
	{
		var source = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
		source.CancelAfter(TimeSpan.FromMinutes(2));
		return source;
	}

	private async Task<IReadOnlyList<RelayItem>> AllConfigItems(RelayScope scope, string kind, CancellationToken cancellation)
	{
		var items = new List<RelayItem>();
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
		}
		while (token is not null);
		return items;
	}

	public async Task<RelayConfigEncoded> ExportAsync(RelayScope scope, string? format, CancellationToken cancellation)
	{
		using var deadline = ConfigDeadline(cancellation);
		cancellation = deadline.Token;
		scope.Validate();
		if (format != "json")
			throw new OperationException(OperationFailure.InvalidInput, "Use Commander Relay JSON.");
		var scopes = new List<RelayScope>();
		var warnings = new List<string>
		{
			"SAS key material is excluded. New policies receive Azure-generated keys; existing policy keys are preserved."
		};
		if (scope.Kind == "namespace")
			foreach (var kind in new[]
			{
				"hybrid",
				"wcf"
			}

			)
				scopes.AddRange((await AllConfigItems(scope, kind, cancellation)).Select(i => i.Target.Scope));
		else
			scopes.Add(scope);
		var total = scopes.Count;
		async Task<IReadOnlyList<RelayConfigPolicy>> Policies(RelayScope parent)
		{
			var policies = await AllConfigItems(parent, "policies", cancellation);
			total += policies.Count;
			if (total > 100)
				throw new OperationException(OperationFailure.OperationBlocked, "Configuration exceeds 100 resources/policies. Export a smaller scope.");
			return policies.Select(p => new RelayConfigPolicy(p.Target.PolicyName!, p.Rights!)).ToArray();
		}

		List<RelayConfigResource> resources = [];
		foreach (var selected in scopes)
		{
			var details = await gateway!.GetAsync(new(selected, null), cancellation);
			if (details.Warning is not null && !warnings.Contains(details.Warning))
				warnings.Add(details.Warning);
			if (details.Settings is null || details.Properties.Any(p => p.Name == "isDynamic" && p.Value?.Equals("true", StringComparison.OrdinalIgnoreCase) == true))
				throw new OperationException(OperationFailure.InvalidInput, "A selected Relay has dynamic or unrepresentable settings. Export a different resource; no partial file was saved.");
			resources.Add(new(selected.Kind, selected.Name, details.Settings, await Policies(selected)));
		}

		var namespacePolicies = scope.Kind == "namespace" ? await Policies(scope) : [];
		var archive = new RelayConfigArchive(RelayConfiguration.Format, 1, Timestamp(clock.GetUtcNow()), connection!.Namespace, resources, namespacePolicies, warnings);
		var bytes = RelayConfiguration.Encode(archive, format!);
		return new(Convert.ToBase64String(bytes), resources.Count + namespacePolicies.Count + resources.Sum(r => r.Policies.Count), warnings.AsReadOnly());
	}

	public async Task<RelayConfigPreview> PreviewAsync(Func<RelayConfigArchive> readArchive, CancellationToken cancellation)
	{
		configPreview = null;
		using var deadline = ConfigDeadline(cancellation);
		cancellation = deadline.Token;
		var archive = readArchive();
		var entries = new List<RelayConfigEntry>();
		var changes = new Dictionary<string, RelayChange>();
		async Task Add(RelayTarget target, RelaySettings? settings, IReadOnlyList<string>? rights, string? issue = null)
		{
			rights = rights is null ? null : Array.AsReadOnly(rights.ToArray());
			RelayDetails? current = null;
			try
			{
				current = await gateway!.GetAsync(target, cancellation);
			}
			catch (Exception error) when (failures.Classify(error).NotFound)
			{
			}

			var action = current is null ? "create" : "update";
			if (current?.Warning is not null && current.Settings is null && target.PolicyName is null)
				issue = "Existing settings cannot be represented. Manage this resource separately.";
			if (current is not null && target.PolicyName is null && (current.Properties.Any(p => p.Name == "isDynamic" && p.Value?.Equals("true", StringComparison.OrdinalIgnoreCase) == true) || (target.Scope.Kind == "wcf" && current.Settings?.RelayType != settings?.RelayType)))
				issue = "Dynamic Relays or a change of WCF Relay type cannot be imported over an existing resource.";
			if (target.Scope.Kind == "namespace" && target.PolicyName == "RootManageSharedAccessKey" && rights?.Contains("Manage") != true)
				issue = "Keep the namespace root policy and its Manage rights.";
			var id = Guid.NewGuid().ToString();
			entries.Add(new(id, target, issue is null ? action : "blocked", settings, rights, current?.Settings, current?.Rights is { } currentRights ? Array.AsReadOnly(currentRights.ToArray()) : null, issue));
			if (issue is null)
				changes.Add(id, new(Guid.NewGuid().ToString(), connection!.ConnectionId, target, action, current?.Revision, settings, rights, null, true));
		}

		foreach (var resource in archive.Resources)
		{
			var scope = new RelayScope(resource.Kind, resource.Name);
			var issue = resource.Settings is null ? "Relay settings are missing or incomplete. This resource and its policies are blocked." : null;
			await Add(new(scope, null), resource.Settings, null, issue);
			var parentIssue = entries[^1].Issue;
			foreach (var p in resource.Policies)
				await Add(new(scope, p.Name), null, p.Rights, parentIssue);
		}

		foreach (var p in archive.NamespacePolicies)
			await Add(new(new("namespace", ""), p.Name), null, p.Rights);
		var expires = clock.GetUtcNow().AddMinutes(10);
		var preview = new RelayConfigPreview(Guid.NewGuid().ToString(), archive.SourceNamespace, connection!.Namespace, Timestamp(expires), entries.AsReadOnly(), Array.AsReadOnly(archive.Warnings.ToArray()));
		cancellation.ThrowIfCancellationRequested();
		configPreview = new(preview, changes, expires);
		return preview;
	}

	public async Task<RelayConfigResult> ApplyAsync(RelayConfigApply request, string stamp, Func<RelayConfigProgress, Task> emit, CancellationToken cancellation)
	{
		if (!request.Acknowledged || !Guid.TryParse(request.ImportId, out _) || request.EntryIds is null || request.EntryIds.Count is < 1 or > 100 || request.EntryIds.Distinct().Count() != request.EntryIds.Count)
			throw new OperationException(OperationFailure.InvalidInput, "Select distinct import entries and acknowledge the destination and changes.");
		if (receipts.CheckRequest(request.Id, stamp) is { } prior)
			return prior;
		var plan = configPreview;
		if (plan is null || plan.Preview.ImportId != request.ImportId || plan.ExpiresAt < clock.GetUtcNow())
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
		var steps = selected.Select(e => new RelayConfigStep(e.Target, "not-attempted", null)).ToArray();
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
				await emit(new(request.Id, index * 100 / selected.Length, $"Importing Relay configuration: {index}/{selected.Length} targets confirmed."));
			}
			catch
			{
				status = "cancelled";
				break;
			}

			var receipt = await administration.ApplyAsync(plan.Changes[selected[index].Id], token);
			steps[index] = new(receipt.Target, receipt.Status, receipt);
			if (receipt.Status != "confirmed")
			{
				status = receipt.Status;
				break;
			}
		}

		var confirmed = steps.Count(s => s.Status == "confirmed");
		var summary = $"{confirmed}/{steps.Length} targets confirmed. " + (status == "completed" ? "Configuration import completed." : status == "unknown" ? "A write may have been accepted. Review Azure state before another change. Nothing was retried." : status == "cancelled" ? "Stopped at cancellation or the two-minute limit. Earlier confirmed writes remain applied." : "Stopped at the first failed target. Earlier confirmed writes remain applied.");
		var result = new RelayConfigResult(request.Id, status, summary, Array.AsReadOnly(steps));
		receipts.Add(request.Id, stamp, result);
		return result;
	}
}
