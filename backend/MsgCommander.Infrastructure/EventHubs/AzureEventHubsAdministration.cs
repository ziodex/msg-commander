using System.ClientModel.Primitives;
using System.Security.Cryptography;
using System.Text.Json;
using Azure;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.ResourceManager;
using System.Text.Json.Nodes;
using Azure.ResourceManager.EventHubs;
using Azure.ResourceManager.EventHubs.Models;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Infrastructure.EventHubs;

public sealed class AzureEventHubsAdministration(ArmClient client, EventHubsNamespaceResource resource) : IEventHubsAdministration
{
	private static readonly JsonElement PreserveCapture = JsonSerializer.SerializeToElement(new { mode = "preserve" });
	// Older namespaces can return retention in days; use it only as a read fallback.
#pragma warning disable CS0618
	private static long? LegacyRetentionHours(EventHubData data) => data.MessageRetentionInDays * 24;
#pragma warning restore CS0618
	private string Scope(string hub) => resource.Id + (hub.Length == 0 ? "" : "/eventhubs/" + hub);
	public async Task<EventAdminContext> ContextAsync(CancellationToken cancellation)
	{
		var data = (await resource.GetAsync(cancellation)).Value.Data;
		return new(resource.Id.ToString(), data.Sku?.Name.ToString() ?? "Unknown", data.DisableLocalAuth ?? false);
	}
	private async Task<EventHubResource> Hub(string name, CancellationToken cancellation) => (await resource.GetEventHubs().GetAsync(name, cancellation)).Value;
	public static string Revision<T>(T data) => Convert.ToHexString(SHA256.HashData(ModelReaderWriter.Write(data).ToMemory().Span));
	public static EventAdminDetails ProjectHub(EventAdminTarget target, EventHubData data, JsonObject? raw = null)
	{
		var policy = data.RetentionDescription?.CleanupPolicy?.ToString() ?? "Delete";
		EventHubSettings? settings = null;
		string? warning = null;
		try
		{
			settings = new(checked((int)(data.PartitionCount ?? data.PartitionIds.Count)), data.Status?.ToString() ?? "Active", policy,
				policy == "Compact" ? null : checked((int?)(data.RetentionDescription?.RetentionTimeInHours ?? LegacyRetentionHours(data))),
				data.RetentionDescription?.TombstoneRetentionTimeInHours, checked((int?)data.RetentionDescription?.MinCompactionLagTimeInMinutes), data.UserMetadata ?? "", PreserveCapture);
			settings.Validate();
		}
		catch (Exception error) when (error is OperationException or OverflowException)
		{
			settings = null;
			warning = "These hub settings cannot be represented by this editor. Inspection and confirmed deletion remain available; no settings will be silently replaced.";
		}
		List<PropertyValue> properties = [Property("Status", data.Status?.ToString()), Property("Partition count", data.PartitionCount), Property("Cleanup policy", policy), Property("Retention hours", data.RetentionDescription?.RetentionTimeInHours), Property("Created", data.CreatedOn), Property("Updated", data.UpdatedOn), Property("Message timestamp type", data.MessageTimestampType?.ToString())];
		var capture = data.CaptureDescription;
		if (capture is not null)
		{
			properties.AddRange([Property("Capture enabled", capture.Enabled), Property("Capture encoding", capture.Encoding?.ToString()), Property("Capture interval seconds", capture.IntervalInSeconds), Property("Capture size bytes", capture.SizeLimitInBytes), Property("Skip empty archives", capture.SkipEmptyArchives), Property("Capture destination", capture.Destination?.Name), Property("Capture storage account", capture.Destination?.StorageAccountResourceId), Property("Capture container", capture.Destination?.BlobContainer), Property("Capture archive format", capture.Destination?.ArchiveNameFormat), Property("Capture identity", capture.Destination?.Identity?.IdentityType?.ToString()), Property("Capture user identity", capture.Destination?.Identity?.UserAssignedIdentity)]);
		}
		return new(target, raw is null ? Revision(data) : RawRevision(raw), settings, null, null, properties, warning);
	}
	private static EventAdminDetails ProjectGroup(EventAdminTarget target, EventHubsConsumerGroupData data, JsonObject raw) => new(target, RawRevision(raw), null,
		data.UserMetadata is { Length: > 1024 } ? null : data.UserMetadata ?? "", null,
		[Property("Created", data.CreatedOn), Property("Updated", data.UpdatedOn)], data.UserMetadata is { Length: > 1024 } ? "Metadata exceeds this editor's 1,024-character limit; editing is disabled." : null);
	private AuthorizationRule ProjectPolicy(string hub, EventHubsAuthorizationRuleData data) => AccessPolicyRules.Project(Scope(hub), data.Name, data.Rights.Select(r => r.ToString()).ToArray());
	private async Task<EventHubsAuthorizationRuleData> PolicyData(EventAdminTarget target, CancellationToken cancellation) => target.HubName == ""
		? (await resource.GetEventHubsNamespaceAuthorizationRules().GetAsync(target.Name, cancellation)).Value.Data
		: (await (await Hub(target.HubName!, cancellation)).GetEventHubAuthorizationRules().GetAsync(target.Name, cancellation)).Value.Data;
	public async Task<EventAdminDetails> GetAsync(EventAdminTarget target, CancellationToken cancellation)
	{
		target.Validate();
		if (target.Kind == "hub")
		{
			var response = await resource.GetEventHubs().GetAsync(target.Name, cancellation);
			return ProjectHub(target, response.Value.Data, Raw(response));
		}
		if (target.Kind == "group")
		{
			var response = await (await Hub(target.HubName!, cancellation)).GetEventHubsConsumerGroups().GetAsync(target.Name, cancellation);
			return ProjectGroup(target, response.Value.Data, Raw(response));
		}
		var policy = ProjectPolicy(target.HubName!, await PolicyData(target, cancellation));
		return new(target, policy.Revision, null, null, policy.Rights, [], null);
	}
	public async Task<EventPolicyPage> PoliciesAsync(string hub, string? continuation, CancellationToken cancellation)
	{
		if (hub.Length == 0)
		{
			await foreach (var page in resource.GetEventHubsNamespaceAuthorizationRules().GetAllAsync(cancellation).AsPages(continuation, 100))
				return new(page.Values.Select(p => ProjectPolicy(hub, p.Data)).ToArray(), page.ContinuationToken);
		}
		else
		{
			EventHubsValidation.Name(hub);
			await foreach (var page in (await Hub(hub, cancellation)).GetEventHubAuthorizationRules().GetAllAsync(cancellation).AsPages(continuation, 100))
				return new(page.Values.Select(p => ProjectPolicy(hub, p.Data)).ToArray(), page.ContinuationToken);
		}
		return new([], null);
	}
	public async Task<AuthorizationKey> KeyAsync(EventAdminTarget target, string keyType, CancellationToken cancellation)
	{
		target.Validate();
		if (target.Kind != "policy")
			throw new OperationException(OperationFailure.InvalidInput, "Select a SAS policy.");
		AccessPolicyRules.KeyType(keyType);
		var keys = target.HubName == ""
			? (await (await resource.GetEventHubsNamespaceAuthorizationRules().GetAsync(target.Name, cancellation)).Value.GetKeysAsync(cancellation)).Value
			: (await (await (await Hub(target.HubName!, cancellation)).GetEventHubAuthorizationRules().GetAsync(target.Name, cancellation)).Value.GetKeysAsync(cancellation)).Value;
		return keyType == "PrimaryKey" ? new(keys.PrimaryKey, keys.PrimaryConnectionString) : new(keys.SecondaryKey, keys.SecondaryConnectionString);
	}
	public static void ApplyHub(EventHubData data, EventHubSettings settings, bool creating, EventAdminContext context)
	{
		EventHubAdministrationRules.ValidateUpdate(settings, creating, data.PartitionCount,
			data.RetentionDescription?.CleanupPolicy?.ToString() ?? "Delete", context);
		data.PartitionCount = settings.PartitionCount;
		data.Status = Enum.Parse<EventHubEntityStatus>(settings.Status);
		data.UserMetadata = settings.UserMetadata;
		data.RetentionDescription ??= new();
		data.RetentionDescription.CleanupPolicy = new CleanupPolicyRetentionDescription(settings.CleanupPolicy);
		// Compact-only retention is a server sentinel; preserve it on updates and omit it on creates.
		if (settings.CleanupPolicy != "Compact")
			data.RetentionDescription.RetentionTimeInHours = settings.RetentionHours;
		data.RetentionDescription.TombstoneRetentionTimeInHours = settings.TombstoneHours;
		data.RetentionDescription.MinCompactionLagTimeInMinutes = settings.MinCompactionLagMinutes;
		var capture = settings.Capture;
		var mode = capture.GetProperty("mode").GetString();
		if (mode == "disabled")
		{
			data.CaptureDescription ??= new();
			data.CaptureDescription.Enabled = false;
		}
		else if (mode == "configure")
		{
			// Replacing Capture is explicit; preserve is the default, including legacy destinations and future fields.
			var identity = capture.GetProperty("identity").GetString();
			data.CaptureDescription = new CaptureDescription
			{
				Enabled = true,
				Encoding = EncodingCaptureDescription.Avro,
				IntervalInSeconds = capture.GetProperty("intervalSeconds").GetInt32(),
				SizeLimitInBytes = capture.GetProperty("sizeBytes").GetInt32(),
				SkipEmptyArchives = capture.GetProperty("skipEmpty").GetBoolean(),
				Destination = new EventHubDestination { Name = "EventHubArchive.AzureBlockBlob", StorageAccountResourceId = new Azure.Core.ResourceIdentifier(capture.GetProperty("storageAccountResourceId").GetString()!), BlobContainer = capture.GetProperty("blobContainer").GetString(), ArchiveNameFormat = capture.GetProperty("archiveNameFormat").GetString(), Identity = identity == "none" ? null : new EventHubsCaptureIdentity { IdentityType = identity == "UserAssigned" ? EventHubsCaptureIdentityType.UserAssigned : EventHubsCaptureIdentityType.SystemAssigned, UserAssignedIdentity = identity == "UserAssigned" ? capture.GetProperty("userAssignedIdentity").GetString() : null } }
			};
		}
	}
	public async Task ChangeAsync(EventAdminChange change, Action dispatching, CancellationToken cancellation)
	{
		change.Validate();
		var target = change.Target;
		var context = await ContextAsync(cancellation);
		EventAdminDetails? current = null;
		try
		{
			current = await GetAsync(target, cancellation);
		}
		catch (RequestFailedException error) when (error.Status == 404 && change.Action == "create") { }
		if (change.Action == "create" && current is not null)
			throw new OperationException(OperationFailure.RevisionConflict, "This resource already exists. Load it to edit its settings.");
		if (change.Action != "create" && current?.Revision != change.ExpectedRevision)
			throw new OperationException(OperationFailure.RevisionConflict, "The resource changed since it was loaded. Refresh and review before continuing.");
		if (target.Kind == "hub")
		{
			var response = change.Action == "create" ? null : await resource.GetEventHubs().GetAsync(target.Name, cancellation);
			var hubResource = response?.Value;
			var raw = response is null ? new JsonObject { ["properties"] = new JsonObject() } : Raw(response);
			var data = hubResource?.Data ?? new EventHubData();
			if (change.Action != "create" && RawRevision(raw) != change.ExpectedRevision)
				throw new OperationException(OperationFailure.RevisionConflict, "Hub settings changed. Reload before continuing.");
			if (change.Action != "delete")
				ApplyHub(data, change.Settings!, change.Action == "create", context);
			cancellation.ThrowIfCancellationRequested();
			dispatching();
			if (change.Action == "delete")
				await hubResource!.DeleteAsync(WaitUntil.Completed, cancellation);
			else
				await PutPreservingProperties(change, data, raw, cancellation);
		}
		else if (target.Kind == "group")
		{
			if (context.Tier == "Basic" && change.Action == "create")
				throw new OperationException(OperationFailure.InvalidInput, "Basic namespaces support only the built-in consumer group.");
			var parent = await Hub(target.HubName!, cancellation);
			var response = change.Action == "create" ? null : await parent.GetEventHubsConsumerGroups().GetAsync(target.Name, cancellation);
			var group = response?.Value;
			var raw = response is null ? new JsonObject { ["properties"] = new JsonObject() } : Raw(response);
			if (group is not null && RawRevision(raw) != change.ExpectedRevision)
				throw new OperationException(OperationFailure.RevisionConflict, "Consumer group changed. Reload before continuing.");
			var data = group?.Data ?? new EventHubsConsumerGroupData();
			if (change.Action != "delete")
				data.UserMetadata = change.UserMetadata;
			cancellation.ThrowIfCancellationRequested();
			dispatching();
			if (change.Action == "delete")
				await group!.DeleteAsync(WaitUntil.Completed, cancellation);
			else
				await PutPreservingProperties(change, data, raw, cancellation);
		}
		else
		{
			var rights = new EventHubsAuthorizationRuleData();
			if (change.Rights is not null)
				foreach (var right in AccessPolicyRules.Rights(change.Rights))
					rights.Rights.Add(new EventHubsAccessRight(right));
			var rotation = change.Action == "regenerate" ? new EventHubsRegenerateAccessKeyContent(change.KeyType == "PrimaryKey" ? EventHubsAccessKeyType.PrimaryKey : EventHubsAccessKeyType.SecondaryKey) : null;
			// Resource GETs are preflight only. Mark dispatch immediately before the mutating SDK call.
			if (target.HubName == "")
			{
				var collection = resource.GetEventHubsNamespaceAuthorizationRules();
				var rule = change.Action == "create" ? null : (await collection.GetAsync(target.Name, cancellation)).Value;
				if (rule is not null && ProjectPolicy("", rule.Data).Revision != change.ExpectedRevision)
					throw new OperationException(OperationFailure.RevisionConflict, "Policy rights changed. Reload before continuing.");
				cancellation.ThrowIfCancellationRequested();
				dispatching();
				if (change.Action == "delete")
					await rule!.DeleteAsync(WaitUntil.Completed, cancellation);
				else if (rotation is not null)
					await rule!.RegenerateKeysAsync(rotation, cancellation);
				else
					await collection.CreateOrUpdateAsync(WaitUntil.Completed, target.Name, rights, cancellation);
			}
			else
			{
				var collection = (await Hub(target.HubName!, cancellation)).GetEventHubAuthorizationRules();
				var rule = change.Action == "create" ? null : (await collection.GetAsync(target.Name, cancellation)).Value;
				if (rule is not null && ProjectPolicy(target.HubName!, rule.Data).Revision != change.ExpectedRevision)
					throw new OperationException(OperationFailure.RevisionConflict, "Policy rights changed. Reload before continuing.");
				cancellation.ThrowIfCancellationRequested();
				dispatching();
				if (change.Action == "delete")
					await rule!.DeleteAsync(WaitUntil.Completed, cancellation);
				else if (rotation is not null)
					await rule!.RegenerateKeysAsync(rotation, cancellation);
				else
					await collection.CreateOrUpdateAsync(WaitUntil.Completed, target.Name, rights, cancellation);
			}
		}
	}
	private static JsonObject Raw<T>(Response<T> response) => JsonNode.Parse(response.GetRawResponse().Content.ToString())!.AsObject();
	private static string RawRevision(JsonObject raw) => Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw.ToJsonString())));
	private sealed class Transport(ArmClient client, ResourceIdentifier id) : ArmResource(client, id)
	{
		public HttpPipeline RequestPipeline => Pipeline;
		public Uri RequestEndpoint => Endpoint;
		public string Version(ResourceType type) => TryGetApiVersion(type, out var version) ? version : "2026-01-01";
	}
	private readonly Transport transport = new(client, resource.Id);
	private async Task PutPreservingProperties<T>(EventAdminChange change, T data, JsonObject raw, CancellationToken cancellation)
	{
		// The generated wire writer drops unknown/version-gated fields. Patch the original
		// Azure response, preserving every field outside the explicit editable settings.
		var target = change.Target;
		var properties = raw["properties"]!.DeepClone().AsObject();
		if (target.Kind == "hub")
		{
			var settings = change.Settings!;
			properties["partitionCount"] = settings.PartitionCount;
			properties["status"] = settings.Status;
			properties["userMetadata"] = settings.UserMetadata;
			var retention = properties["retentionDescription"] as JsonObject ?? new JsonObject();
			retention["cleanupPolicy"] = settings.CleanupPolicy;
			if (settings.CleanupPolicy != "Compact")
				retention["retentionTimeInHours"] = settings.RetentionHours;
			if (settings.TombstoneHours is not null)
				retention["tombstoneRetentionTimeInHours"] = settings.TombstoneHours;
			if (settings.MinCompactionLagMinutes is not null)
				retention["minCompactionLagTimeInMinutes"] = settings.MinCompactionLagMinutes;
			if (properties["retentionDescription"] is null)
				properties["retentionDescription"] = retention;
			properties.Remove("messageRetentionInDays");
			var mode = settings.Capture.GetProperty("mode").GetString();
			if (mode == "disabled")
			{
				var capture = properties["captureDescription"] as JsonObject ?? new JsonObject();
				capture["enabled"] = false;
				if (properties["captureDescription"] is null)
					properties["captureDescription"] = capture;
			}
			else if (mode == "configure")
				properties["captureDescription"] = JsonNode.Parse(ModelReaderWriter.Write(data).ToString())!["properties"]!["captureDescription"]!.DeepClone();
		}
		else
			properties["userMetadata"] = change.UserMetadata;
		foreach (var name in new[] { "createdAt", "updatedAt", "partitionIds", "identifier" })
			properties.Remove(name);
		var type = target.Kind == "hub" ? EventHubResource.ResourceType : EventHubsConsumerGroupResource.ResourceType;
		var version = transport.Version(type);
		var path = resource.Id + "/eventhubs/" + Uri.EscapeDataString(target.Kind == "hub" ? target.Name : target.HubName!) +
			(target.Kind == "group" ? "/consumergroups/" + Uri.EscapeDataString(target.Name) : "");
		using var message = transport.RequestPipeline.CreateMessage();
		message.Request.Method = RequestMethod.Put;
		message.Request.Uri.Reset(new Uri(transport.RequestEndpoint, path + "?api-version=" + Uri.EscapeDataString(version!)));
		message.Request.Headers.SetValue("Content-Type", "application/json");
		message.Request.Content = RequestContent.Create(BinaryData.FromString(new JsonObject { ["properties"] = properties }.ToJsonString()));
		await transport.RequestPipeline.SendAsync(message, cancellation);
		if (message.Response.Status >= 400)
			throw new RequestFailedException(message.Response.Status, "Azure rejected the management change.");
		if (message.Response.Status is not (200 or 201))
			throw new IOException("Azure has not confirmed completion of this change.");
	}
}
