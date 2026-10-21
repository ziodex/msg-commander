using System.Text.Json;

namespace MsgCommander.Host;

public sealed class NotificationHubWorkspace : IAsyncDisposable
{
	private readonly NotificationHubManagementOwner owner;
	public NotificationHubWorkspace(INotificationHubGatewayFactory factory, TimeProvider? timeProvider = null) => owner = new(factory, new AzureProviderCredentialCodec(), new AzureNotificationHubFailureClassifier(), timeProvider);
	public async Task<object?> ExecuteAsync(string method, JsonElement input, Func<object, Task> emit, CancellationToken cancellation)
	{
		var operationId = input.TryGetProperty(method == "nh.connect" ? "operationId" : "id", out var id) ? id.GetString() : null;
		Func<DeviceCodeEvent, Task>? prompt = operationId is null ? null : code => emit(new { type = "device-code", operationId, code = code.Code, expiresOn = code.ExpiresOn });
		if (method == "nh.reset")
		{
			await owner.ResetAsync(cancellation);
			return null;
		}

		if (method == "nh.connect")
			return await owner.ConnectAsync(() => NotificationHubRequests.Connect(input), prompt, cancellation);
		var connectionId = input.GetProperty("connectionId").GetString();
		if (method == "nh.disconnect")
		{
			await owner.DisconnectAsync(connectionId, operationId, cancellation);
			return null;
		}

		return await owner.ExecuteAsync<object?>(connectionId, operationId, prompt, async (context, token) =>
		{
			switch (method)
			{
				case "nh.config.export":
					return await context.Configuration.ExportAsync(NotificationHubRequests.Scope(input), input.GetProperty("format").GetString(), token);
				case "nh.config.preview":
					return await context.Configuration.PreviewAsync(() => NotificationHubConfiguration.Decode(input.GetProperty("contentBase64").GetString()!), token);
				case "nh.config.apply":
					return await context.Configuration.ApplyAsync(NotificationHubRequests.Apply(input), NotificationHubRequests.Fingerprint(input), progress => emit(progress), token);
				case "nh.config.result":
					return context.Configuration.GetResult(input.GetProperty("operationId").GetString()!);
				case "nh.credentials.get":
					return await context.Gateway.CredentialsAsync(NotificationHubRequests.Target(input), input.GetProperty("provider").GetString()!, token);
				case "nh.credentials.import":
					return context.Credentials.Import(NotificationHubRequests.Import(input), token);
				case "nh.credentials.discard":
					context.Credentials.Discard(NotificationHubRequests.Target(input), input.GetProperty("artifactId").GetString()!);
					return null;
				case "nh.credentials.change":
					var change = NotificationHubRequests.CredentialChange(input);
					return await context.Credentials.ChangeAsync(new(change.Id, change.Target, change.ExpectedRevision, change.Acknowledged), NotificationHubRequests.Fingerprint(input), () => NotificationHubRequests.Draft(change.Draft), token);
				case "nh.get":
					return await context.Gateway.GetAsync(NotificationHubRequests.Target(input), token);
				case "nh.key":
					return await context.Gateway.KeyAsync(NotificationHubRequests.Target(input), input.GetProperty("keyType").GetString()!, token);
				case "nh.list":
					return await context.Browsing.ListAsync(NotificationHubRequests.Scope(input), input.GetProperty("kind").GetString()!, input.GetProperty("continuationToken").GetString(), token);
				case "nh.change":
					return await context.Administration.ChangeAsync(NotificationHubRequests.Change(input), NotificationHubRequests.Fingerprint(input), token);
				case "nh.result":
					return context.Receipts.Get(input.GetProperty("operationId").GetString()!);
				default:
					throw new OperationException(OperationFailure.UnknownOperation, "Unknown Notification Hubs operation.");
			}
		}, cancellation);
	}

	internal INotificationHubManagementAccess Access => owner;

	public ValueTask DisposeAsync() => owner.DisposeAsync();
}
