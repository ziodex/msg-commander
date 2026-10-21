using Azure.Core;
using Azure.Identity;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.Connections;
using static MsgCommander.Application.Common.DisplayValues;
namespace MsgCommander.Infrastructure.Authentication;

public static class AzureDeviceCodeCredential
{
	public static TokenCredential Create(string tenant, string client, Func<DeviceCodeEvent, Task> deviceCode)
	{
		if (!Guid.TryParse(client, out _) || string.IsNullOrEmpty(tenant) || tenant.Length > 100 || !System.Text.RegularExpressions.Regex.IsMatch(tenant, @"^[A-Za-z0-9.-]+$"))
			throw new OperationException(OperationFailure.InvalidInput, "Enter an Entra tenant and public client application ID.");
		return new DeviceCodeCredential(new DeviceCodeCredentialOptions
		{
			TenantId = tenant,
			ClientId = client,
			AuthorityHost = AzureAuthorityHosts.AzurePublicCloud,
			DeviceCodeCallback = (code, token) => { token.ThrowIfCancellationRequested(); return deviceCode(new(code.UserCode, Timestamp(code.ExpiresOn))); },
			Retry = { MaxRetries = 0 }
		});
	}
}
