using System.Text.Json.Nodes;
using Azure.Core;
namespace MsgCommander.Infrastructure.NotificationHubs;

public sealed partial class AzureNotificationHubGateway
{
	public async Task<NotificationHubCredentialStatus> CredentialsAsync(NotificationHubTarget target, string provider, CancellationToken cancellation)
	{
		NotificationHubCredentials.Hub(target);
		var property = NotificationHubCredentials.Property(provider);
		var version = NotificationHubCredentials.Version(provider);
		var raw = await Request(RequestMethod.Get, Path(target), null, cancellation, apiVersion: version);
		CheckId(raw, Path(target));
		return new(provider, raw["properties"]?[property] is JsonObject, Revision(target, raw), version);
	}
	public async Task ChangeCredentialAsync(NotificationHubTarget target, string provider, string revision, ProviderCredentialMaterial? material, Action dispatching, CancellationToken cancellation)
	{
		var properties = material switch
		{
			null => (JsonObject?)null,
			AzureProviderCredentialMaterial data when data.Provider == provider => data.Properties,
			_ => throw new OperationException(OperationFailure.InvalidInput, "Credential material belongs to another provider or codec.")
		};
		NotificationHubCredentials.Hub(target);
		var property = NotificationHubCredentials.Property(provider);
		var version = NotificationHubCredentials.Version(provider);
		var raw = await Request(RequestMethod.Get, Path(target), null, cancellation, apiVersion: version);
		CheckId(raw, Path(target));
		if (Revision(target, raw) != revision)
			throw new OperationException(OperationFailure.RevisionConflict, "The hub changed since provider settings were loaded. Refresh and review before replacing credentials.");
		var body = new JsonObject { ["properties"] = new JsonObject { [property] = properties is null ? null : new JsonObject { ["properties"] = properties.DeepClone() } } };
		cancellation.ThrowIfCancellationRequested();
		dispatching();
		await Request(RequestMethod.Patch, Path(target), body, cancellation, apiVersion: version, acknowledgeOnly: true);
	}
}
