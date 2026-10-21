using Azure.Core;
using Azure.Identity;
using Azure.Messaging.ServiceBus.Administration;
using MsgCommander.Application.ServiceBus.Connections;

namespace MsgCommander.Infrastructure.ServiceBus.Connections;

public sealed class AzureServiceBusAuthenticationProbe(
	Func<string, ServiceBusAdministrationClient>? administration = null,
	Func<ConnectionProfile, Func<DeviceCodeEvent, Task>, TokenCredential>? credentials = null) : IServiceBusAuthenticationProbe
{
	public async Task<AuthenticationCheck> CheckAsync(ConnectionProfile profile, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		if (profile.Service != "service-bus")
			throw new OperationException(OperationFailure.InvalidInput, "Authentication checks for this service arrive with its adapter.");
		if (profile.Auth == "sas")
		{
			var endpoint = ServiceBusEndpoint.Resolve(profile);
			var client = administration?.Invoke(endpoint.Administration) ?? new ServiceBusAdministrationClient(endpoint.Administration,
				new ServiceBusAdministrationClientOptions { Retry = { MaxRetries = 0, NetworkTimeout = TimeSpan.FromSeconds(20) } });
			await client.GetNamespacePropertiesAsync(cancellation);
			return new("Service Bus namespace access verified with Manage permission. No messages were read or changed.");
		}
		if (profile.Auth != "device-code")
			throw new OperationException(OperationFailure.InvalidInput, "Unsupported authentication method.");
		var credential = credentials?.Invoke(profile, deviceCode) ?? new DeviceCodeCredential(new DeviceCodeCredentialOptions
		{
			TenantId = profile.TenantId,
			ClientId = profile.ClientId,
			AuthorityHost = AzureAuthorityHosts.AzurePublicCloud,
			DeviceCodeCallback = (code, token) =>
			{
				token.ThrowIfCancellationRequested();
				return deviceCode(new(code.UserCode, code.ExpiresOn.ToString("O")));
			},
			Retry = { MaxRetries = 0 }
		});
		await credential.GetTokenAsync(new TokenRequestContext(["https://servicebus.azure.net/.default"]), cancellation);
		return new("Microsoft Entra sign-in succeeded for the Service Bus audience. Namespace roles and ARM access have not been tested.");
	}
}
