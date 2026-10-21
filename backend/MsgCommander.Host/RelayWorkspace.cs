using System.Text.Json;

namespace MsgCommander.Host;

public sealed class RelayWorkspace : IAsyncDisposable
{
	private readonly RelayConnectionOwner owner;
	public RelayWorkspace(IRelayGatewayFactory factory, TimeProvider? timeProvider = null) => owner = new(factory, new AzureRelayFailureClassifier(), timeProvider);
	public async Task<object?> ExecuteAsync(string method, JsonElement input, Func<object, Task> emit, CancellationToken cancellation)
	{
		var id = input.TryGetProperty(method == "relay.connect" ? "operationId" : "id", out var operation) ? operation.GetString() : null;
		Func<DeviceCodeEvent, Task>? prompt = id is null ? null : code => emit(new { type = "device-code", operationId = id, code = code.Code, expiresOn = code.ExpiresOn });
		if (method == "relay.reset")
		{
			await owner.ResetAsync(cancellation);
			return null;
		}

		if (method == "relay.connect")
			return await owner.ConnectAsync(() => RelayRequests.Connect(input), prompt, cancellation);
		var connectionId = input.GetProperty("connectionId").GetString();
		if (method == "relay.disconnect")
		{
			await owner.DisconnectAsync(connectionId, id, cancellation);
			return null;
		}

		return await owner.ExecuteAsync<object?>(connectionId, id, prompt, async (context, token) =>
		{
			switch (method)
			{
				case "relay.config.export":
					return await context.Configuration.ExportAsync(RelayRequests.Read<RelayScope>(input.GetProperty("scope")), input.GetProperty("format").GetString(), token);
				case "relay.config.preview":
					return await context.Configuration.PreviewAsync(() => RelayConfiguration.Decode(input.GetProperty("contentBase64").GetString()!), token);
				case "relay.config.apply":
					return await context.Configuration.ApplyAsync(RelayRequests.Read<RelayConfigApply>(input), RelayRequests.Fingerprint(input), progress => emit(progress), token);
				case "relay.config.result":
					return context.Configuration.GetResult(input.GetProperty("operationId").GetString()!);
				case "relay.get":
					return await context.Gateway.GetAsync(RelayRequests.Target(input), token);
				case "relay.key":
					return await context.Gateway.KeyAsync(RelayRequests.Target(input), input.GetProperty("keyType").GetString()!, token);
				case "relay.list":
					return await context.Browsing.ListAsync(RelayRequests.Read<RelayScope>(input.GetProperty("scope")), input.GetProperty("kind").GetString()!, input.GetProperty("continuationToken").GetString(), token);
				case "relay.change":
					return await context.Administration.ChangeAsync(RelayRequests.Read<RelayChange>(input), RelayRequests.Fingerprint(input), token);
				case "relay.result":
					return context.Administration.GetResult(input.GetProperty("operationId").GetString()!);
				default:
					throw new OperationException(OperationFailure.UnknownOperation, "Unknown Relay operation.");
			}
		}, cancellation);
	}

	public ValueTask DisposeAsync() => owner.DisposeAsync();
}
