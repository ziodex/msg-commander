using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.ResourceManager;
using Azure.ResourceManager.ServiceBus;
using Azure.ResourceManager.ServiceBus.Models;

namespace MsgCommander.Infrastructure.ServiceBus;

public sealed partial class AzureAuthorizationGateway(ArmClient client, string resourceId) : IAuthorizationGateway
{
	public static async Task<IAuthorizationGateway> ConnectAsync(AuthorizationContext context, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		var credential = new DeviceCodeCredential(new DeviceCodeCredentialOptions
		{
			TenantId = context.TenantId,
			ClientId = context.ClientId,
			AuthorityHost = AzureAuthorityHosts.AzurePublicCloud,
			DeviceCodeCallback = (code, token) => { token.ThrowIfCancellationRequested(); return deviceCode(new(code.UserCode, MsgCommander.Application.Common.DisplayValues.Timestamp(code.ExpiresOn))); },
			Retry = { MaxRetries = 0 }
		});
		var options = new ArmClientOptions { Environment = ArmEnvironment.AzurePublicCloud, Retry = { MaxRetries = 0, NetworkTimeout = TimeSpan.FromSeconds(20) }, Diagnostics = { IsLoggingContentEnabled = false } };
		var client = new ArmClient(credential, defaultSubscriptionId: null, options);
		await client.GetServiceBusNamespaceResource(new ResourceIdentifier(context.ResourceId)).GetAsync(cancellation);
		return new AzureAuthorizationGateway(client, context.ResourceId);
	}
	private ServiceBusNamespaceResource Namespace => client.GetServiceBusNamespaceResource(new ResourceIdentifier(resourceId));
	private string Scope(AuthorizationTarget target)
	{
		target.Validate();
		return target.Kind == "namespace" ? resourceId : $"{resourceId}/{(target.Kind == "queue" ? "queues" : "topics")}/{target.Name}";
	}
	private ResourceIdentifier RuleId(AuthorizationTarget target, string name)
	{
		AccessPolicyRules.ValidateName(name);
		return new($"{Scope(target)}/authorizationRules/{Uri.EscapeDataString(name)}");
	}
	private ServiceBusQueueResource Queue(AuthorizationTarget target) => client.GetServiceBusQueueResource(new ResourceIdentifier(Scope(target)));
	private ServiceBusTopicResource Topic(AuthorizationTarget target) => client.GetServiceBusTopicResource(new ResourceIdentifier(Scope(target)));
	private AuthorizationRule Project(AuthorizationTarget target, ServiceBusAuthorizationRuleData data) => AccessPolicyRules.Project(Scope(target), data.Name, data.Rights.Select(r => r.ToString()).ToArray());
	public async Task<AuthorizationPage> ListAsync(AuthorizationTarget target, CancellationToken cancellation)
	{
		target.Validate();
		List<AuthorizationRule> items = [];
		if (Nested(target))
			return await ListNestedAsync(target, cancellation);
		void Add(ServiceBusAuthorizationRuleData data)
		{
			if (items.Count >= 100)
				throw new OperationException(OperationFailure.InspectionLimit, "SAS rule list exceeds the 100-rule local limit.");
			items.Add(Project(target, data));
		}
		switch (target.Kind)
		{
			case "namespace":
				await foreach (var item in Namespace.GetServiceBusNamespaceAuthorizationRules().GetAllAsync(cancellation))
					Add(item.Data);
				break;
			case "queue":
				await foreach (var item in Queue(target).GetServiceBusQueueAuthorizationRules().GetAllAsync(cancellation))
					Add(item.Data);
				break;
			case "topic":
				await foreach (var item in Topic(target).GetServiceBusTopicAuthorizationRules().GetAllAsync(cancellation))
					Add(item.Data);
				break;
		}
		return new(items);
	}
	public async Task<AuthorizationRule> GetAsync(AuthorizationTarget target, string name, CancellationToken cancellation)
	{
		if (Nested(target))
			return ProjectNested(target, await SendNestedAsync(target, name, null, RequestMethod.Get, null, cancellation));
		var id = RuleId(target, name);
		var data = target.Kind switch
		{
			"namespace" => (await client.GetServiceBusNamespaceAuthorizationRuleResource(id).GetAsync(cancellation)).Value.Data,
			"queue" => (await client.GetServiceBusQueueAuthorizationRuleResource(id).GetAsync(cancellation)).Value.Data,
			_ => (await client.GetServiceBusTopicAuthorizationRuleResource(id).GetAsync(cancellation)).Value.Data
		};
		return Project(target, data);
	}
	public async Task<AuthorizationKey> KeyAsync(AuthorizationTarget target, string name, string keyType, CancellationToken cancellation)
	{
		AccessPolicyRules.KeyType(keyType);
		if (Nested(target))
		{
			var value = await SendNestedAsync(target, name, "listKeys", RequestMethod.Post, null, cancellation);
			var slot = keyType == "PrimaryKey" ? "primary" : "secondary";
			return new(value.GetProperty(slot + "Key").GetString()!, value.GetProperty(slot + "ConnectionString").GetString()!);
		}
		var id = RuleId(target, name);
		var keys = target.Kind switch
		{
			"namespace" => (await client.GetServiceBusNamespaceAuthorizationRuleResource(id).GetKeysAsync(cancellation)).Value,
			"queue" => (await client.GetServiceBusQueueAuthorizationRuleResource(id).GetKeysAsync(cancellation)).Value,
			_ => (await client.GetServiceBusTopicAuthorizationRuleResource(id).GetKeysAsync(cancellation)).Value
		};
		return keyType == "PrimaryKey" ? new(keys.PrimaryKey, keys.PrimaryConnectionString) : new(keys.SecondaryKey, keys.SecondaryConnectionString);
	}
	public async Task ChangeAsync(string action, AuthorizationTarget target, string name, IReadOnlyList<string>? rights, string? expectedRevision, string? keyType, Action dispatching, CancellationToken cancellation)
	{
		target.Validate();
		AccessPolicyRules.ValidateName(name);
		if (action is not ("create" or "update" or "delete" or "regenerate"))
			throw new OperationException(OperationFailure.InvalidInput, "Unsupported SAS rule action.");
		var data = new ServiceBusAuthorizationRuleData();
		if (action is "create" or "update")
			foreach (var right in AccessPolicyRules.Rights(rights))
				data.Rights.Add(Enum.Parse<ServiceBusAccessRight>(right));
		if (action == "regenerate")
			AccessPolicyRules.KeyType(keyType);
		if (action == "create")
		{
			AuthorizationRule? existing = null;
			try
			{
				existing = await GetAsync(target, name, cancellation);
			}
			catch (RequestFailedException e) when (e.Status == 404) { }
			if (existing is not null)
				throw new OperationException(OperationFailure.RevisionConflict, "This SAS rule already exists. Open it to edit its rights.");
		}
		else
		{
			var current = await GetAsync(target, name, cancellation);
			if (current.Revision != expectedRevision)
				throw new OperationException(OperationFailure.RevisionConflict, "SAS rule rights changed. Reload and review before continuing.");
		}
		// ARM has no conditional revision parameter here. This preflight is best effort.
		cancellation.ThrowIfCancellationRequested();
		dispatching();
		if (Nested(target))
		{
			await SendNestedAsync(target, name, action == "regenerate" ? "regenerateKeys" : null,
				action == "delete" ? RequestMethod.Delete : action == "regenerate" ? RequestMethod.Post : RequestMethod.Put,
				action is "create" or "update" ? new
				{
					properties = new
					{
						rights
					}
				} : action == "regenerate" ? (object)new
				{
					keyType
				} : null, cancellation);
			return;
		}
		var id = RuleId(target, name);
		if (action is "create" or "update")
		{
			switch (target.Kind)
			{
				case "namespace":
					await Namespace.GetServiceBusNamespaceAuthorizationRules().CreateOrUpdateAsync(WaitUntil.Completed, name, data, cancellation);
					break;
				case "queue":
					await Queue(target).GetServiceBusQueueAuthorizationRules().CreateOrUpdateAsync(WaitUntil.Completed, name, data, cancellation);
					break;
				case "topic":
					await Topic(target).GetServiceBusTopicAuthorizationRules().CreateOrUpdateAsync(WaitUntil.Completed, name, data, cancellation);
					break;
			}
		}
		else if (action == "delete")
		{
			switch (target.Kind)
			{
				case "namespace":
					await client.GetServiceBusNamespaceAuthorizationRuleResource(id).DeleteAsync(WaitUntil.Completed, cancellation);
					break;
				case "queue":
					await client.GetServiceBusQueueAuthorizationRuleResource(id).DeleteAsync(WaitUntil.Completed, cancellation);
					break;
				case "topic":
					await client.GetServiceBusTopicAuthorizationRuleResource(id).DeleteAsync(WaitUntil.Completed, cancellation);
					break;
			}
		}
		else
		{
			var content = new ServiceBusRegenerateAccessKeyContent(keyType == "PrimaryKey" ? ServiceBusAccessKeyType.PrimaryKey : ServiceBusAccessKeyType.SecondaryKey);
			// Rotation returns both keys. Never put them in a receipt or event.
			switch (target.Kind)
			{
				case "namespace":
					await client.GetServiceBusNamespaceAuthorizationRuleResource(id).RegenerateKeysAsync(content, cancellation);
					break;
				case "queue":
					await client.GetServiceBusQueueAuthorizationRuleResource(id).RegenerateKeysAsync(content, cancellation);
					break;
				case "topic":
					await client.GetServiceBusTopicAuthorizationRuleResource(id).RegenerateKeysAsync(content, cancellation);
					break;
			}
		}
	}
}
