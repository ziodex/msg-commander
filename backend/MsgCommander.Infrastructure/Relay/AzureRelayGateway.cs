using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Azure;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.ResourceManager;
using Azure.ResourceManager.Relay;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Infrastructure.Relay;

public sealed class AzureRelayGatewayFactory : IRelayGatewayFactory
{
	public async Task<IRelayGateway> ConnectAsync(ConnectionProfile profile, RelayManagement management, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		management.Validate(profile.Namespace);
		if (profile.Service != "relay")
			throw new OperationException(OperationFailure.InvalidInput, "Select a Relay profile.");
		var credential = MsgCommander.Infrastructure.Authentication.AzureDeviceCodeCredential.Create(management.TenantId, management.ClientId, deviceCode);
		var options = new ArmClientOptions
		{
			Environment = ArmEnvironment.AzurePublicCloud,
			Retry =
			{
				MaxRetries = 0,
				NetworkTimeout = TimeSpan.FromSeconds(20)
			},
			Diagnostics =
			{
				IsLoggingContentEnabled = false
			}
		};
		options.SetApiVersion(RelayNamespaceResource.ResourceType, "2024-01-01");
		var client = new ArmClient(credential, defaultSubscriptionId: null, options);
		return await AzureRelayGateway.ConnectAsync(client, profile.Namespace, management.ResourceId, cancellation);
	}
}

public sealed class AzureRelayGateway : IRelayGateway
{
	private sealed class Transport(ArmClient client, ResourceIdentifier id) : ArmResource(client, id)
	{
		public HttpPipeline RequestPipeline => Pipeline;
		public Uri RequestEndpoint => Endpoint;
	}

	private readonly Transport transport;
	private readonly string resourceId;
	public string Location
	{
		get;
	}

	private const string ApiVersion = "2024-01-01";
	private AzureRelayGateway(ArmClient client, string resourceId, string location)
	{
		transport = new(client, new ResourceIdentifier(resourceId));
		this.resourceId = resourceId;
		Location = location;
	}

	public static async Task<AzureRelayGateway> ConnectAsync(ArmClient client, string host, string resourceId, CancellationToken cancellation)
	{
		var resource = (await client.GetRelayNamespaceResource(new ResourceIdentifier(resourceId)).GetAsync(cancellation)).Value;
		if (!Uri.TryCreate(resource.Data.ServiceBusEndpoint, UriKind.Absolute, out var endpoint) || !string.Equals(endpoint.Host, host, StringComparison.OrdinalIgnoreCase))
			throw new OperationException(OperationFailure.InvalidInput, "Relay namespace endpoint does not match this profile.");
		return new(client, resourceId, resource.Data.Location.ToString());
	}

	private string Path(RelayTarget target) => resourceId + RelayResourcePath.For(target);
	private async Task<JsonObject> Request(RequestMethod method, string path, JsonObject? body, CancellationToken cancellation, string? nextLink = null)
	{
		var uri = new Uri(transport.RequestEndpoint, path + "?api-version=" + ApiVersion);
		if (nextLink is not null)
		{
			if (!Uri.TryCreate(nextLink, UriKind.Absolute, out var next) || next.Scheme != "https" || next.Host != transport.RequestEndpoint.Host || !next.IsDefaultPort || next.UserInfo != "" || next.Fragment != "" || !string.Equals(next.AbsolutePath, uri.AbsolutePath, StringComparison.OrdinalIgnoreCase))
				throw new OperationException(OperationFailure.OperationBlocked, "Azure returned a continuation outside the selected Relay list.");
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
			throw new RequestFailedException(status, "Azure rejected the Relay request.");
		if (status is not (200 or 201 or 204))
			throw new IOException("Relay completion was not confirmed.");
		if (message.Response.Content.ToMemory().Length > 4 * 1024 * 1024)
			throw new IOException("Relay response exceeded the local limit.");
		return status == 204 || message.Response.Content.ToMemory().Length == 0 ? new() : JsonNode.Parse(message.Response.Content.ToString())!.AsObject();
	}

	// Runtime counters and timestamps must not make an otherwise unchanged form stale.
	public static JsonObject Writable(JsonObject raw)
	{
		var properties = raw["properties"]!.DeepClone().AsObject();
		foreach (var key in new[]
		{
			"createdAt",
			"updatedAt",
			"listenerCount",
			"isDynamic"
		}

		)
			properties.Remove(key);
		return properties;
	}

	public static string Revision(RelayTarget target, JsonObject raw)
	{
		static JsonNode? Sort(JsonNode? node) => node switch
		{
			JsonObject obj => new JsonObject(obj.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => new KeyValuePair<string, JsonNode?>(p.Key, Sort(p.Value)))),
			JsonArray array => new JsonArray(array.Select(Sort).ToArray()),
			_ => node?.DeepClone()
		};
		return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(RelayResourcePath.For(target) + (raw["properties"]?["createdAt"]?.ToString() ?? "") + Sort(Writable(raw))!.ToJsonString())));
	}

	private static IReadOnlyList<string> Rights(JsonObject properties) => AccessPolicyRules.Rights(properties["rights"]!.AsArray().Select(v => v!.GetValue<string>()).ToArray());
	public static RelayDetails Project(RelayTarget target, JsonObject raw)
	{
		var p = raw["properties"]!.AsObject();
		RelaySettings? settings = null;
		string? warning = null;
		var policy = target.PolicyName is not null;
		if (!policy && target.Scope.Kind != "namespace")
		{
			try
			{
				settings = new(p["userMetadata"]?.GetValue<string>() ?? "", p["requiresClientAuthorization"]!.GetValue<bool>(), target.Scope.Kind == "wcf" ? p["relayType"]?.GetValue<string>() : null, target.Scope.Kind == "wcf" ? p["requiresTransportSecurity"]?.GetValue<bool>() : null);
				settings.Validate(target.Scope.Kind);
			}
			catch (Exception error) when (error is OperationException or InvalidOperationException or NullReferenceException)
			{
				settings = null;
				warning = "These settings cannot be represented by this editor. Inspect or delete explicitly; no defaults will replace them.";
			}
		}

		if (!policy && target.Scope.Kind != "namespace" && Writable(raw).Any(pair => pair.Key is not ("userMetadata" or "requiresClientAuthorization" or "relayType" or "requiresTransportSecurity")))
			warning = (warning is null ? "" : warning + " ") + "Additional writable fields are kept by the editor but excluded from configuration files. Review destination settings separately.";
		List<PropertyValue> values = [Property("Resource ID", raw["id"]?.GetValue<string>())];
		foreach (var key in new[]
		{
			"listenerCount",
			"createdAt",
			"updatedAt",
			"isDynamic",
			"relayType",
			"requiresClientAuthorization",
			"requiresTransportSecurity",
			"provisioningState",
			"serviceBusEndpoint",
			"publicNetworkAccess",
			"minimumTlsVersion"
		}

		)
			if (p[key] is { } value)
				values.Add(Property(key, value.ToString()));
		if (p["userMetadata"] is { } metadata)
			values.Add(Property("userMetadata", metadata.ToString().Length > 1024 ? metadata.ToString()[..1024] : metadata.ToString()));
		return new(target, Revision(target, raw), settings, policy ? Rights(p) : null, values, warning);
	}

	public async Task<RelayDetails> GetAsync(RelayTarget target, CancellationToken cancellation)
	{
		target.Validate();
		return Project(target, await Request(RequestMethod.Get, Path(target), null, cancellation));
	}

	public async Task<RelayPage> ListAsync(RelayScope scope, string kind, string? continuation, CancellationToken cancellation)
	{
		scope.Validate();
		if (kind is not ("hybrid" or "wcf" or "policies") || (kind != "policies" && scope.Kind != "namespace"))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid Relay list scope.");
		var path = resourceId + RelayResourcePath.For(scope) + "/" + (kind == "policies" ? "authorizationRules" : kind == "hybrid" ? "hybridConnections" : "wcfRelays");
		var raw = await Request(RequestMethod.Get, path, null, cancellation, continuation);
		var items = raw["value"]!.AsArray();
		if (items.Count > 250)
			throw new OperationException(OperationFailure.OperationBlocked, "Relay page exceeds the 250-resource limit.");
		var rows = items.Select(row =>
		{
			var name = row!["name"]!.GetValue<string>();
			var target = kind == "policies" ? new RelayTarget(scope, name) : new(new(kind, name), null);
			target.Validate();
			var p = row["properties"]!.AsObject();
			return new RelayItem(target, p["listenerCount"]?.GetValue<int>(), p["requiresClientAuthorization"]?.GetValue<bool>(), p["relayType"]?.GetValue<string>(), kind == "policies" ? Rights(p) : null);
		}).ToArray();
		return new(rows, raw["nextLink"]?.GetValue<string>());
	}

	public async Task<AuthorizationKey> KeyAsync(RelayTarget target, string keyType, CancellationToken cancellation)
	{
		target.Validate();
		AccessPolicyRules.KeyType(keyType);
		if (target.PolicyName is null)
			throw new OperationException(OperationFailure.InvalidInput, "Select a Relay SAS policy.");
		var keys = await Request(RequestMethod.Post, Path(target) + "/listKeys", null, cancellation);
		var slot = keyType == "PrimaryKey" ? "primary" : "secondary";
		return new(keys[slot + "Key"]!.GetValue<string>(), keys[slot + "ConnectionString"]!.GetValue<string>());
	}

	public async Task ChangeAsync(RelayChange change, Action dispatching, CancellationToken cancellation)
	{
		change.Validate();
		var target = change.Target;
		var path = Path(target);
		JsonObject? raw = null;
		try
		{
			raw = await Request(RequestMethod.Get, path, null, cancellation);
		}
		catch (RequestFailedException error) when (error.Status == 404 && change.Action == "create")
		{
		}

		if (change.Action == "create" && raw is not null)
			throw new OperationException(OperationFailure.RevisionConflict, "This Relay resource already exists. Load it to edit its settings.");
		if (change.Action != "create" && (raw is null || Revision(target, raw) != change.ExpectedRevision))
			throw new OperationException(OperationFailure.RevisionConflict, "The Relay resource changed since it was loaded. Refresh and review before continuing.");
		if (target.PolicyName == "RootManageSharedAccessKey" && target.Scope.Kind == "namespace" && (change.Action == "delete" || (change.Rights is not null && !change.Rights.Contains("Manage"))))
			throw new OperationException(OperationFailure.InvalidInput, "Keep the namespace root policy and its Manage rights. Use a separate policy for restricted access.");
		var properties = raw is null ? new JsonObject() : Writable(raw);
		if (change.Settings is { } settings)
		{
			if (raw is not null && raw["properties"]?["isDynamic"]?.GetValue<bool>() == true)
				throw new OperationException(OperationFailure.InvalidInput, "Dynamically created WCF Relays are managed by their listener; editing them here is unavailable.");
			if (raw is not null && target.Scope.Kind == "wcf" && properties["relayType"]?.GetValue<string>() != settings.RelayType)
				throw new OperationException(OperationFailure.InvalidInput, "Relay type cannot be changed by this editor. Create a separate resource for a different binding.");
			properties["userMetadata"] = settings.UserMetadata;
			properties["requiresClientAuthorization"] = settings.RequiresClientAuthorization;
			if (target.Scope.Kind == "wcf")
			{
				properties["relayType"] = settings.RelayType;
				properties["requiresTransportSecurity"] = settings.RequiresTransportSecurity;
			}
		}

		if (change.Rights is not null)
			properties["rights"] = new JsonArray(AccessPolicyRules.Rights(change.Rights).Select(v => (JsonNode?)JsonValue.Create(v)).ToArray());
		cancellation.ThrowIfCancellationRequested();
		dispatching();
		if (change.Action == "delete")
			await Request(RequestMethod.Delete, path, null, cancellation);
		else if (change.Action == "regenerate")
			await Request(RequestMethod.Post, path + "/regenerateKeys", new()
			{
				["keyType"] = change.KeyType
			}, cancellation);
		else
			await Request(RequestMethod.Put, path, new()
			{
				["properties"] = properties
			}, cancellation);
	}

	public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
