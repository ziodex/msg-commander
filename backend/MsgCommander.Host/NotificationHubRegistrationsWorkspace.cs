using System.Text.Json;
using static MsgCommander.Host.NotificationHubDataRequests;

namespace MsgCommander.Host;

public sealed class NotificationHubRegistrationsWorkspace : IAsyncDisposable
{
	private readonly NotificationHubRegistrationOwner owner;
	public NotificationHubRegistrationsWorkspace(INotificationHubRegistrationsGatewayFactory factory, NotificationHubWorkspace management, TimeProvider? timeProvider = null) => owner = new(factory, management.Access, new AzureRegistrationFileCodec(), timeProvider);
	public async Task<object?> ExecuteAsync(string method, JsonElement input, CancellationToken cancellation, Func<object, Task>? emit = null)
	{
		if (method == "nh.registrations.reset")
		{
			await owner.ResetAsync(cancellation);
			return null;
		}

		if (method == "nh.registrations.connect")
			return await owner.ConnectAsync(() => Connect(input), cancellation);
		var connectionId = String(input, "connectionId");
		var operationId = String(input, "id");
		if (method == "nh.registrations.disconnect")
		{
			await owner.DisconnectAsync(connectionId, operationId, cancellation);
			return null;
		}

		return await owner.ExecuteAsync<object?>(connectionId, operationId, async (context, token) =>
		{
			switch (method)
			{
				case "nh.registrations.jobs.list":
					return await context.Jobs.ListAsync(token);
				case "nh.registrations.jobs.get":
					return await context.Jobs.GetAsync(input.GetProperty("jobId").GetString()!, token);
				case "nh.registrations.jobs.result":
					return context.Jobs.GetResult(input.GetProperty("operationId").GetString()!);
				case "nh.registrations.jobs.discard":
					context.Jobs.Discard();
					return null;
				case "nh.registrations.jobs.preview":
					return context.Jobs.Preview(() => Read<NotificationHubJobPreview>(input).Draft, token);
				case "nh.registrations.jobs.submit":
					var submit = Read<NotificationHubJobSubmit>(input);
					return await context.Jobs.SubmitAsync(submit, Fingerprint(submit), token);
				case "nh.registrations.files.export":
					return context.Files.Export(Read<string[]>(input.GetProperty("snapshotIds")), input.GetProperty("format").GetString(), token);
				case "nh.registrations.files.preview":
					return context.Files.Preview(() => input.GetProperty("contentBase64").GetString()!, token);
				case "nh.registrations.files.inspect":
					return context.Files.Inspect(String(input, "importId"), String(input, "entryId"));
				case "nh.registrations.files.apply":
					return await context.Files.ApplyAsync(Read<RegistrationFileApply>(input), RawFingerprint(input), progress => emit?.Invoke(progress) ?? Task.CompletedTask, token);
				case "nh.registrations.files.result":
					return context.Files.GetResult(input.GetProperty("operationId").GetString()!);
				case "nh.registrations.inspect":
					return context.Browsing.Inspect(String(input, "snapshotId"));
				case "nh.registrations.get":
					return await context.Browsing.ReloadAsync(String(input, "snapshotId"), token);
				case "nh.registrations.result":
					return context.Administration.GetResult(String(input, "operationId") ?? "");
				case "nh.registrations.change":
					var change = Read<NotificationHubRegistrationChange>(input);
					return await context.Administration.ChangeAsync(change, Fingerprint(change), token);
				case "nh.registrations.query":
					return await context.Browsing.QueryAsync(Read<NotificationHubRegistrationQuery>(input.GetProperty("query")), input.GetProperty("continuationToken").GetString(), token);
				default:
					throw new OperationException(OperationFailure.UnknownOperation, "Unknown registration operation.");
			}
		}, cancellation);
	}

	public ValueTask DisposeAsync() => owner.DisposeAsync();
}
