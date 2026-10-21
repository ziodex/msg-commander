using System.Text.Json;

namespace MsgCommander.Host;

public sealed class EventGridWorkspace : IAsyncDisposable
{
	private readonly EventGridConnectionOwner owner;
	public EventGridWorkspace(IEventGridGatewayFactory factory, TimeProvider? timeProvider = null) => owner = new(factory, new AzureEventGridFailureClassifier(), timeProvider);
	public async Task<object?> ExecuteAsync(string method, JsonElement input, Func<object, Task> emit, CancellationToken cancellation)
	{
		if (method == "eg.reset")
		{
			await owner.ResetAsync(cancellation);
			return null;
		}
		var operationId = input.TryGetProperty(method == "eg.connect" ? "operationId" : "id", out var id) ? id.GetString() : null;
		if (!Guid.TryParse(operationId, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid Event Grid operation ID.");
		Task Prompt(DeviceCodeEvent code) => emit(new
		{
			type = "device-code",
			operationId,
			code = code.Code,
			expiresOn = code.ExpiresOn
		});
		if (method == "eg.connect")
			return await owner.ConnectAsync(() => EventGridRequests.Connect(input), Prompt, cancellation);
		var connectionId = input.GetProperty("connectionId").GetString();
		if (method == "eg.disconnect")
		{
			await owner.DisconnectAsync(connectionId, cancellation);
			return null;
		}
		return await owner.ExecuteAsync<object?>(connectionId, Prompt, async (context, token) =>
		{
			switch (method)
			{
				case "eg.pull.receive":
					return await context.Pull.ReceiveAsync(EventGridRequests.Receive(input), EventGridRequests.Fingerprint(input), progress => emit(progress), token);
				case "eg.pull.settle":
					return await context.Pull.SettleAsync(EventGridRequests.Settle(input), EventGridRequests.Fingerprint(input), progress => emit(progress), token);
				case "eg.pull.result":
					return context.Pull.GetResult(input.GetProperty("operationId").GetString()!);
				case "eg.pull.list":
					return context.Pull.List(EventGridRequests.Target(input));
				case "eg.pull.clear":
					return context.Pull.List(EventGridRequests.Target(input), true);
				case "eg.pull.inspect":
					return context.Pull.Inspect(EventGridRequests.Target(input), input.GetProperty("handle").GetString()!);
				case "eg.publish":
					return await context.Publishing.ExecuteAsync(EventGridRequests.Publish(input), EventGridRequests.Fingerprint(input), progress => emit(progress), token);
				case "eg.publish.result":
					return context.Publishing.GetResult(input.GetProperty("operationId").GetString()!);
				case "eg.admin.change":
					return await context.Administration.ChangeAsync(EventGridRequests.Change(input), EventGridRequests.Fingerprint(input), token);
				case "eg.admin.result":
					return context.Administration.GetResult(input.GetProperty("operationId").GetString()!);
				case "eg.admin.get":
					return await context.Browsing.AdminGetAsync(EventGridRequests.Target(input), token);
				case "eg.get":
					return await context.Browsing.InspectAsync(EventGridRequests.Target(input), token);
				case "eg.list":
					return await context.Browsing.ListAsync(EventGridRequests.Target(input), input.GetProperty("continuationToken").GetString(), token);
				default:
					throw new OperationException(OperationFailure.UnknownOperation, "Unknown Event Grid read operation.");
			}
		}, cancellation);
	}
	public ValueTask DisposeAsync() => owner.DisposeAsync();
}
