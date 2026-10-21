using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Azure;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.ResourceManager;
using static MsgCommander.Application.Common.DisplayValues;
namespace MsgCommander.Infrastructure.NotificationHubs;

public sealed class AzureNotificationHubGatewayFactory : INotificationHubGatewayFactory
{
	public async Task<INotificationHubGateway> ConnectAsync(ConnectionProfile profile, NotificationHubManagement management, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		management.Validate(profile.Namespace);
		if (profile.Service != "notification-hubs")
			throw new OperationException(OperationFailure.InvalidInput, "Select a Notification Hubs profile.");
		var credential = MsgCommander.Infrastructure.Authentication.AzureDeviceCodeCredential.Create(management.TenantId, management.ClientId, deviceCode);
		var options = new ArmClientOptions { Environment = ArmEnvironment.AzurePublicCloud, Retry = { MaxRetries = 0, NetworkTimeout = TimeSpan.FromSeconds(20) }, Diagnostics = { IsLoggingContentEnabled = false } };
		return await AzureNotificationHubGateway.ConnectAsync(new ArmClient(credential, null, options), profile.Namespace, management.ResourceId, cancellation);
	}
}
public sealed partial class AzureNotificationHubGateway : INotificationHubGateway
{
	private sealed class Transport(ArmClient client, ResourceIdentifier id) : ArmResource(client, id)
	{
		public HttpPipeline RequestPipeline => Pipeline; public Uri RequestEndpoint => Endpoint;
	}
	private readonly Transport transport;
	private readonly string resourceId;
	public string Location { get; private set; } = "";
	public const string ApiVersion = "2023-09-01";
	private AzureNotificationHubGateway(ArmClient client, string resourceId)
	{
		transport = new(client, new ResourceIdentifier(resourceId));
		this.resourceId = resourceId;
	}
	public static async Task<AzureNotificationHubGateway> ConnectAsync(ArmClient client, string host, string resourceId, CancellationToken cancellation)
	{
		var gateway = new AzureNotificationHubGateway(client, resourceId);
		var raw = await gateway.Request(RequestMethod.Get, resourceId, null, cancellation);
		gateway.CheckId(raw, resourceId);
		if (!Uri.TryCreate(raw["properties"]?["serviceBusEndpoint"]?.GetValue<string>(), UriKind.Absolute, out var endpoint) || endpoint.Scheme != "https" || !endpoint.IsDefaultPort || endpoint.UserInfo != "" || endpoint.Fragment != "" || endpoint.Query != "" || endpoint.AbsolutePath != "/" || !string.Equals(endpoint.Host, host, StringComparison.OrdinalIgnoreCase))
			throw new OperationException(OperationFailure.InvalidInput, "Notification Hubs namespace endpoint does not match this profile.");
		gateway.Location = raw["location"]!.GetValue<string>();
		if (gateway.Location.Length is < 1 or > 128)
			throw new IOException("Invalid Notification Hubs location.");
		return gateway;
	}
	private string Path(NotificationHubTarget target) => resourceId + target.Suffix();
	private void CheckId(JsonObject raw, string expected)
	{
		if (!string.Equals(Uri.UnescapeDataString(raw["id"]?.GetValue<string>() ?? ""), Uri.UnescapeDataString(expected), StringComparison.OrdinalIgnoreCase))
			throw new OperationException(OperationFailure.OperationBlocked, "Azure returned a resource outside the selected Notification Hubs scope.");
	}
	private async Task<JsonObject> Request(RequestMethod method, string path, JsonObject? body, CancellationToken cancellation, string? nextLink = null, string? apiVersion = null, bool acknowledgeOnly = false)
	{
		var uri = new Uri(transport.RequestEndpoint, path + "?api-version=" + (apiVersion ?? ApiVersion));
		if (nextLink is not null)
		{
			if (!Uri.TryCreate(nextLink, UriKind.Absolute, out var next) || next.Scheme != "https" || next.Host != transport.RequestEndpoint.Host || !next.IsDefaultPort || next.UserInfo != "" || next.Fragment != "" || !string.Equals(next.AbsolutePath, uri.AbsolutePath, StringComparison.OrdinalIgnoreCase))
				throw new OperationException(OperationFailure.OperationBlocked, "Azure returned a continuation outside the selected Notification Hubs list.");
			uri = next;
		}
		using var message = transport.RequestPipeline.CreateMessage();
		message.Request.Method = method;
		message.Request.Uri.Reset(uri);
		if (body is not null)
		{
			message.Request.Headers.SetValue("Content-Type", "application/json");
			message.Request.Content = RequestContent.Create(BinaryData.FromString(body.ToJsonString()));
		}
		await transport.RequestPipeline.SendAsync(message, cancellation);
		var status = message.Response.Status;
		if (status >= 400)
			throw new RequestFailedException(status, "Azure rejected the Notification Hubs request.");
		if (status is not (200 or 201 or 204))
			throw new IOException("Notification Hubs completion was not confirmed.");
		if (acknowledgeOnly)
			return new();
		if (message.Response.Content.ToMemory().Length > 4 * 1024 * 1024)
			throw new IOException("Notification Hubs response exceeded the local limit.");
		return status == 204 || message.Response.Content.ToMemory().Length == 0 ? new() : JsonNode.Parse(message.Response.Content.ToString())!.AsObject();
	}
	public static string Revision(NotificationHubTarget target, JsonObject raw)
	{
		static JsonNode? Sort(JsonNode? node) => node switch
		{
			JsonObject obj => new JsonObject(obj.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => new KeyValuePair<string, JsonNode?>(p.Key, Sort(p.Value)))),
			JsonArray array => new JsonArray(array.Select(Sort).ToArray()),
			_ => node?.DeepClone()
		};
		var data = raw.DeepClone().AsObject();
		data.Remove("systemData");
		if (data["properties"] is JsonObject props)
			foreach (var key in new[] { "registrationCount", "installationCount", "updatedAt", "provisioningState" })
				props.Remove(key);
		return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(target.Suffix() + (raw["systemData"]?["createdAt"]?.ToString() ?? "") + Sort(data)!.ToJsonString())));
	}
	private static IReadOnlyList<string> Rights(JsonObject p) => AccessPolicyRules.Rights(p["rights"]!.AsArray().Select(v => v!.GetValue<string>()).ToArray());
	public static NotificationHubDetails Project(NotificationHubTarget target, JsonObject raw)
	{
		var p = raw["properties"]!.AsObject();
		NotificationHubSettings? settings = null;
		string? warning = null;
		if (target.PolicyName is null && target.Scope.Kind == "hub")
		{
			try
			{
				settings = new(p["registrationTtl"]!.GetValue<string>(), (raw["tags"] as JsonObject ?? new()).Select(v => new NotificationHubTag(v.Key, v.Value!.GetValue<string>())).ToArray());
				settings.Validate();
			}
			catch (Exception e) when (e is OperationException or InvalidOperationException or NullReferenceException) { settings = null; warning = "These settings cannot be represented by this editor. Inspect or delete explicitly; no defaults will replace them."; }
		}
		// Only allow-listed non-secret properties cross the process boundary. PNS credentials and embedded rule keys stay private.
		List<PropertyValue> values = [Property("Resource ID", raw["id"]?.GetValue<string>()), Property("Location", raw["location"]?.GetValue<string>())];
		foreach (var key in new[] { "registrationTtl", "dailyMaxActiveDevices", "provisioningState", "status", "createdAt", "updatedAt", "serviceBusEndpoint", "publicNetworkAccess" })
			if (p[key] is { } value)
				values.Add(Property(key, value.ToString()));
		if (raw["sku"]?["name"] is { } sku)
			values.Add(Property("Tier", sku.ToString()));
		return new(target, Revision(target, raw), settings, target.PolicyName is null ? null : Rights(p), values, warning);
	}
	public async Task<NotificationHubDetails> GetAsync(NotificationHubTarget target, CancellationToken cancellation)
	{
		target.Validate();
		var raw = await Request(RequestMethod.Get, Path(target), null, cancellation);
		CheckId(raw, Path(target));
		return Project(target, raw);
	}
	public async Task<NotificationHubPage> ListAsync(NotificationHubScope scope, string kind, string? continuation, CancellationToken cancellation)
	{
		scope.Validate();
		if (kind is not ("hubs" or "policies") || (kind == "hubs" && scope.Kind != "namespace"))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid Notification Hubs list scope.");
		var raw = await Request(RequestMethod.Get, resourceId + scope.Suffix() + "/" + (kind == "hubs" ? "notificationHubs" : "authorizationRules"), null, cancellation, continuation);
		var items = raw["value"]!.AsArray();
		if (items.Count > 250)
			throw new OperationException(OperationFailure.OperationBlocked, "Notification Hubs page exceeds 250 resources.");
		return new(items.Select(row => { var name = row!["name"]!.GetValue<string>(); var target = kind == "hubs" ? new NotificationHubTarget(new("hub", name), null) : new(scope, name); target.Validate(); CheckId(row.AsObject(), Path(target)); var p = row["properties"]!.AsObject(); return new NotificationHubItem(target, kind == "hubs" ? p["registrationTtl"]?.GetValue<string>() : null, kind == "policies" ? Rights(p) : null); }).ToArray(), raw["nextLink"]?.GetValue<string>());
	}
	public async Task<AuthorizationKey> KeyAsync(NotificationHubTarget target, string keyType, CancellationToken cancellation)
	{
		target.Validate();
		AccessPolicyRules.KeyType(keyType);
		if (target.PolicyName is null)
			throw new OperationException(OperationFailure.InvalidInput, "Select a Notification Hubs SAS policy.");
		var keys = await Request(RequestMethod.Post, Path(target) + "/listKeys", null, cancellation);
		var slot = keyType == "PrimaryKey" ? "primary" : "secondary";
		return new(keys[slot + "Key"]!.GetValue<string>(), keys[slot + "ConnectionString"]!.GetValue<string>());
	}
	public async Task ChangeAsync(NotificationHubChange change, Action dispatching, CancellationToken cancellation)
	{
		change.Validate();
		var target = change.Target;
		var path = Path(target);
		JsonObject? raw = null;
		try
		{
			raw = await Request(RequestMethod.Get, path, null, cancellation);
			CheckId(raw, path);
		}
		catch (RequestFailedException e) when (e.Status == 404 && change.Action == "create") { }
		if (change.Action == "create" && raw is not null)
			throw new OperationException(OperationFailure.RevisionConflict, "This Notification Hubs resource already exists. Load it to edit its settings.");
		if (change.Action != "create" && (raw is null || Revision(target, raw) != change.ExpectedRevision))
			throw new OperationException(OperationFailure.RevisionConflict, "The Notification Hubs resource changed since it was loaded. Refresh and review before continuing.");
		if (target.Scope.Kind == "namespace" && string.Equals(target.PolicyName, "RootManageSharedAccessKey", StringComparison.OrdinalIgnoreCase) && (change.Action == "delete" || (change.Rights is not null && !change.Rights.Contains("Manage"))))
			throw new OperationException(OperationFailure.InvalidInput, "Keep the namespace root policy and its Manage rights. Use another policy for restricted access.");
		var properties = new JsonObject();
		JsonObject? body = null;
		var method = RequestMethod.Put;
		if (change.Settings is { } settings)
		{
			properties["registrationTtl"] = settings.RegistrationTtl;
			body = new()
			{
				["properties"] = properties,
				["tags"] = new JsonObject(settings.Tags.Select(t => new KeyValuePair<string, JsonNode?>(t.Name, JsonValue.Create(t.Value))))
			};
			if (change.Action == "create")
				body["location"] = Location;
			else
				method = RequestMethod.Patch;
		}
		if (change.Rights is not null)
			body = new()
			{
				["properties"] = new JsonObject { ["rights"] = new JsonArray(AccessPolicyRules.Rights(change.Rights).Select(v => (JsonNode?)JsonValue.Create(v)).ToArray()) }
			};
		cancellation.ThrowIfCancellationRequested();
		dispatching();
		if (change.Action == "delete")
			await Request(RequestMethod.Delete, path, null, cancellation);
		else if (change.Action == "regenerate")
			await Request(RequestMethod.Post, path + "/regenerateKeys", new()
			{
				["policyKey"] = change.KeyType
			}, cancellation);
		else
			await Request(method, path, body, cancellation, acknowledgeOnly: true);
	}
	public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
