using System.Text.Json;

namespace MsgCommander.Host;

/// <summary>Maps protocol requests to connection-owned application services.</summary>
public sealed class EventHubsWorkspace : IAsyncDisposable
{
	private readonly EventHubsConnectionOwner owner;
	public EventHubsWorkspace(IEventHubsGatewayFactory factory) => owner = new(factory, new AzureEventHubsFailureClassifier(), new AzureConfigurationFailureClassifier());

	public async Task<object?> ExecuteAsync(string method, JsonElement input, Func<object, Task> emit, CancellationToken cancellation)
	{
		var operationId = input.TryGetProperty(method == "eh.connect" ? "operationId" : "id", out var id) ? id.GetString() : null;
		Func<DeviceCodeEvent, Task>? prompt = operationId is null ? null
			: code => emit(new { type = "device-code", operationId, code = code.Code, expiresOn = code.ExpiresOn });
		if (method == "eh.reset")
		{
			await owner.ResetAsync(cancellation);
			return null;
		}
		if (method == "eh.connect")
			return await owner.ConnectAsync(() => EventHubsRequests.Connect(input), prompt, cancellation);
		var connectionId = input.GetProperty("connectionId").GetString();
		if (method == "eh.disconnect")
		{
			await owner.DisconnectAsync(connectionId, cancellation);
			return null;
		}
		var hub = input.TryGetProperty("hubName", out var hubValue) ? hubValue.GetString() : null;
		return await owner.ExecuteAsync<object?>(connectionId, Operation(method), hub, prompt, async (context, token) =>
		{
			switch (method)
			{
				case "eh.config.export":
				case "eh.config.preview":
				case "eh.config.apply":
				case "eh.config.discard":
				case "eh.config.result":
					return await MessagingConfigurationEndpoints.Execute(context.Configuration, method[10..], input, emit, token);
				case "eh.admin.context":
					return await context.Administration.Admin.ContextAsync(token);
				case "eh.admin.get":
					return await context.Administration.Admin.GetAsync(EventHubsRequests.AdminTarget(input), token);
				case "eh.admin.policies":
					return await context.Administration.PoliciesAsync(hub!, input.GetProperty("continuationToken").GetString(), token);
				case "eh.admin.key":
					return await context.Administration.Admin.KeyAsync(EventHubsRequests.AdminTarget(input), input.GetProperty("keyType").GetString()!, token);
				case "eh.admin.change":
					return await context.Administration.ChangeAsync(EventHubsRequests.AdminChange(input), EventHubsRequests.Fingerprint(input), token);
				case "eh.admin.result":
					return context.Administration.GetResult(input.GetProperty("operationId").GetString()!);
				case "eh.list":
					return await context.Browse.ListAsync(input.GetProperty("kind").GetString()!, hub!, input.GetProperty("continuationToken").GetString(), token);
				case "eh.statistics":
					return await context.Browse.StatisticsAsync(hub!, token);
				case "eh.hub":
					return await context.Gateway.GetHubAsync(EventHubsValidation.Name(hub), token, context.Connection.Access == "send");
				case "eh.partition":
					return await context.Gateway.GetPartitionAsync(EventHubsValidation.Name(hub), EventHubsValidation.Partition(input.GetProperty("partitionId").GetString()), token, context.Connection.Access == "send");
				case "eh.send":
					var sendStamp = EventHubsRequests.Fingerprint(input);
					return context.Send.CheckRequest(input.GetProperty("id").GetString()!, sendStamp)
						?? await context.Send.ExecuteAsync(EventHubsRequests.Send(input), sendStamp, progress => emit(progress), token);
				case "eh.send.result":
					return context.Send.GetResult(input.GetProperty("operationId").GetString()!);
				case "eh.listen":
					return await context.Listen.ExecuteAsync(EventHubsRequests.Listen(input), EventHubsRequests.Fingerprint(input), progress => emit(progress), token);
				case "eh.listen.result":
					return context.Listen.GetResult(input.GetProperty("operationId").GetString()!);
				case "eh.read":
					var readStamp = EventHubsRequests.Fingerprint(input);
					return context.Read.CheckRequest(input.GetProperty("id").GetString()!, readStamp)
						?? await context.Read.ExecuteAsync(EventHubsRequests.Read(input), readStamp, progress => emit(progress), token);
				case "eh.read.result":
					return context.Read.GetResult(input.GetProperty("operationId").GetString()!);
				case "eh.export":
					return context.Snapshots.Export(input.GetProperty("snapshotId").GetString()!);
				case "eh.inspect":
					return context.Snapshots.Inspect(input.GetProperty("snapshotId").GetString()!);
				case "eh.body":
					return context.Snapshots.Body(input.GetProperty("snapshotId").GetString()!, input.GetProperty("offset").GetInt32(), input.GetProperty("count").GetInt32());
				default:
					throw new OperationException(OperationFailure.UnknownOperation, "Unknown Event Hubs operation.");
			}
		}, cancellation);
	}
	private static EventHubOperation Operation(string method) => method switch
	{
		"eh.list" => EventHubOperation.Browse,
		"eh.read" => EventHubOperation.Read,
		"eh.listen" => EventHubOperation.Listen,
		_ when method.StartsWith("eh.send", StringComparison.Ordinal) => EventHubOperation.Send,
		_ when method.StartsWith("eh.admin.", StringComparison.Ordinal) => EventHubOperation.Administration,
		_ when method.StartsWith("eh.config.", StringComparison.Ordinal) => EventHubOperation.Configuration,
		_ => EventHubOperation.Shared
	};
	public ValueTask DisposeAsync() => owner.DisposeAsync();
}
