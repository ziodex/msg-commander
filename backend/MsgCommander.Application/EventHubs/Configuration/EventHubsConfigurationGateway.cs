using MsgCommander.Application.Common;
using MsgCommander.Application.AccessPolicies;
using MsgCommander.Application.ResourceConfiguration;
using MsgCommander.Application.EventHubs.Browsing;
using MsgCommander.Application.EventHubs.Administration;
using MsgCommander.Contracts.ResourceConfiguration;
using MsgCommander.Contracts.EventHubs.Browsing;
using MsgCommander.Contracts.EventHubs.Administration;
using System.Text.Json;
namespace MsgCommander.Application.EventHubs.Configuration;

public sealed class EventHubsConfigurationGateway(IEventHubsCatalog gateway, EventHubsConnection connection) : IMessagingConfigurationGateway
{
	public string Service => "event-hubs"; public string Namespace => connection.Namespace; public string ContextKey => connection.ConnectionId;
	private IEventHubsAdministration Admin => gateway.Administration ?? throw new OperationException(OperationFailure.InvalidInput, "Connect Event Hubs with Entra management access before migrating resource configuration.");
	private static EventAdminTarget Target(MessagingConfigTarget t) => new(t.Kind, t.Name, t.ParentKind is null ? null : t.ParentName);
	public async Task<MessagingConfigSnapshot> Read(MessagingConfigTarget target, CancellationToken token)
	{
		var details = await Admin.GetAsync(Target(target), token);
		if (details.Warning is not null && target.Kind == "hub")
			throw new OperationException(OperationFailure.InvalidInput, "Existing hub settings cannot be represented safely. Review this hub separately.");
		var settings = target.Kind switch
		{
			"hub" => MessagingConfiguration.Value(details.Hub!),
			"group" => MessagingConfiguration.Value(new { userMetadata = details.UserMetadata ?? "" }),
			_ => MessagingConfiguration.Value(new { rights = details.Rights! })
		};
		var identity = details.Properties.FirstOrDefault(p => p.Name == "Created")?.Value ?? "";
		return new(new(target, settings, false, null), details.Revision, identity);
	}
	private async Task<IReadOnlyList<MessagingConfigTarget>> List(string kind, string hub, CancellationToken token)
	{
		List<MessagingConfigTarget> rows = [];
		HashSet<string> pages = [], names = [];
		string? next = null;
		do
		{
			var page = await gateway.ListAsync(kind, hub, next, token);
			foreach (var item in page.Items)
			{
				var t = new MessagingConfigTarget(kind == "hubs" ? "hub" : "group", item.Name, kind == "hubs" ? null : "hub", kind == "hubs" ? null : hub);
				if (!names.Add(t.Key()))
					throw MessagingConfiguration.Invalid();
				rows.Add(t);
			}
			next = page.ContinuationToken;
			if (rows.Count > 100 || next is not null && !pages.Add(next))
				throw MessagingConfiguration.Invalid();
		} while (next is not null);
		return rows;
	}
	public async Task<IReadOnlyList<MessagingConfigResource>> Export(MessagingConfigTarget? scope, bool policies, CancellationToken token)
	{
		_ = Admin;
		List<MessagingConfigResource> rows = [];
		async Task Policies(string hub)
		{
			string? next = null;
			HashSet<string> pages = [];
			do
			{
				var page = await Admin.PoliciesAsync(hub, next, token);
				foreach (var p in page.Items)
					rows.Add(new(new("policy", p.Name, hub.Length == 0 ? "namespace" : "hub", hub), MessagingConfiguration.Value(new
					{
						rights = p.Rights
					}), false, null));
				next = page.ContinuationToken;
				if (rows.Count > 100 || next is not null && !pages.Add(next))
					throw MessagingConfiguration.Invalid();
			} while (next is not null);
		}
		async Task Add(MessagingConfigTarget target, bool children = true)
		{
			var resource = (await Read(target, token)).Resource;
			if (target.Kind == "hub")
			{
				var fields = resource.Settings.EnumerateObject().Where(p => p.Name != "capture").ToDictionary(p => p.Name, p => p.Value.Clone());
				resource = resource with
				{
					Settings = MessagingConfiguration.Value(fields)
				};
			}
			rows.Add(resource);
			if (target.Kind == "hub" && children)
				foreach (var child in await List("groups", target.Name, token))
					await Add(child);
			if (target.Kind == "hub" && policies)
				await Policies(target.Name);
			if (rows.Count > 100)
				throw new OperationException(OperationFailure.OperationBlocked, "Configuration exceeds 100 targets. Export a smaller scope.");
		}
		if (scope is null)
		{
			foreach (var hub in await List("hubs", "", token))
				await Add(hub);
			if (policies)
				await Policies("");
		}
		else
		{
			if (scope.Kind == "group")
				await Add(scope.Parent()!, false);
			await Add(scope);
		}
		return rows;
	}
	public async Task<MessagingConfigResource> Prepare(MessagingConfigResource source, MessagingConfigSnapshot? current, CancellationToken token)
	{
		JsonElement settings;
		if (source.Target.Kind == "hub")
		{
			var defaults = new EventHubSettings(4, "Active", "Delete", 24, null, null, "", MessagingConfiguration.Value(new
			{
				mode = current is null ? "disabled" : "preserve"
			}));
			settings = MessagingConfiguration.Merge(current?.Resource.Settings ?? MessagingConfiguration.Value(defaults), source.Settings);
			var proposed = settings.Deserialize<EventHubSettings>(MessagingConfiguration.Json)!;
			proposed.Validate();
			var prior = current?.Resource.Settings.Deserialize<EventHubSettings>(MessagingConfiguration.Json);
			EventHubAdministrationRules.ValidateUpdate(proposed, current is null, prior?.PartitionCount,
				prior?.CleanupPolicy ?? "Delete", await Admin.ContextAsync(token));
		}
		else if (source.Target.Kind == "group")
		{
			settings = MessagingConfiguration.Merge(current?.Resource.Settings ?? MessagingConfiguration.Value(new
			{
				userMetadata = ""
			}), source.Settings);
			var metadata = settings.GetProperty("userMetadata").GetString();
			if (metadata is null || metadata.Length > 1024)
				throw MessagingConfiguration.Invalid();
		}
		else
		{
			var rights = AccessPolicyRules.Rights(source.Settings.GetProperty("rights").Deserialize<string[]>(MessagingConfiguration.Json));
			settings = MessagingConfiguration.Value(new
			{
				rights
			});
		}
		return source with
		{
			Settings = settings
		};
	}
	public Task Write(MessagingConfigResource resource, string phase, string action, MessagingConfigSnapshot? current, string? guard, Action dispatching, CancellationToken token)
	{
		var t = Target(resource.Target);
		var change = new EventAdminChange(Guid.NewGuid().ToString(), connection.ConnectionId, t, action, current?.Revision, t.Kind == "hub" ? resource.Settings.Deserialize<EventHubSettings>(MessagingConfiguration.Json) : null, t.Kind == "group" ? resource.Settings.GetProperty("userMetadata").GetString() : null, t.Kind == "policy" ? resource.Settings.GetProperty("rights").Deserialize<string[]>(MessagingConfiguration.Json) : null, null, true, "");
		change.Validate();
		return Admin.ChangeAsync(change, dispatching, token);
	}
}
