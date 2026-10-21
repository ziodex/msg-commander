using MsgCommander.Application.ServiceBus.Workspace;
using MsgCommander.Infrastructure.ServiceBus.Administration;
using MsgCommander.Infrastructure.ServiceBus.TestJobs;
using System.Text.Json;
using static MsgCommander.Application.Common.DisplayValues;
using static MsgCommander.Application.ServiceBus.Messages.MessageProjection;

namespace MsgCommander.Host;

public sealed partial class ServiceBusWorkspace : IAsyncDisposable
{
	private readonly ServiceBusConnectionOwner owner;
	public ServiceBusWorkspace(IServiceBusGatewayFactory factory, IMessageDeferProvider? messageDeferProvider = null, IMessageFailureClassifier? failureClassifier = null)
	{
		owner = new(factory, new(failureClassifier ?? new AzureMessageFailureClassifier(), new AzureMessageMutationFailureClassifier(),
			new AzureMaintenanceFailureClassifier(), new AzureAdministrationFailureClassifier(), new AzureConfigurationFailureClassifier(), TestJobFailureMapper.Translate),
			messageDeferProvider ?? new InMemoryMessageDeferProvider());
	}
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

	public async Task<object?> ExecuteAsync(string method, JsonElement input, Func<object, Task> emit, CancellationToken cancellation)
	{
		// Listener controls stay available while unrelated foreground requests wait on Azure.
		if (method == "sb.listener.status")
			return owner.ListenerStatus(input.GetProperty("connectionId").GetString());
		if (method == "sb.listener.stop")
			return await owner.StopListenerAsync(input.GetProperty("connectionId").GetString(), input.GetProperty("listenerId").GetString());
		if (method == "sb.listener.settle")
		{
			var request = new ListenerSettlement(input.GetProperty("id").GetString()!, input.GetProperty("deliveryId").GetString()!,
				input.GetProperty("action").GetString()!, input.GetProperty("reason").GetString()!, input.GetProperty("description").GetString()!);
			var fingerprint = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(input.GetRawText())));
			return await owner.SettleListenerAsync(input.GetProperty("connectionId").GetString(), input.GetProperty("listenerId").GetString(), request, fingerprint, cancellation);
		}
		if (method == "sb.reset")
		{
			await owner.ResetAsync(cancellation);
			return null;
		}
		if (method == "sb.connect")
		{
			var profile = input.GetProperty("profile").Deserialize<ConnectionProfile>(Json) ?? throw new OperationException(OperationFailure.InvalidInput, "Missing profile.");
			var operationId = input.GetProperty("operationId").GetString();
			return await owner.ConnectAsync(profile, code => emit(new { type = "device-code", operationId, code = code.Code, expiresOn = code.ExpiresOn }), cancellation);
		}
		var connectionId = input.GetProperty("connectionId").GetString();
		if (method == "sb.disconnect")
		{
			await owner.DisconnectAsync(connectionId, cancellation);
			return null;
		}
		var promptId = Optional(input, "id");
		return await owner.ExecuteAsync<object?>(connectionId, Operation(method), promptId is null ? null :
			code => emit(new { type = "device-code", operationId = promptId, code = code.Code, expiresOn = code.ExpiresOn }), async (context, cancellation) =>
		{
			var gateway = context.Gateway;
			switch (method)
			{
				case "sb.defer.list":
					return ListDeferred(input);
				case "sb.defer.forget":
					return ForgetDeferred(input);
				case "sb.config.export":
				case "sb.config.preview":
				case "sb.config.discard":
				case "sb.config.result":
					return await MessagingConfigurationEndpoints.Execute(Configuration, method[10..], input, emit, cancellation);
				case "sb.config.apply":
					return await MessagingConfigurationEndpoints.Execute(Configuration, "apply", input, emit, cancellation);
				case "sb.listener.start":
					return await StartListener(input, cancellation);
				case "sb.entity.copy.preview":
					return await PreviewCopy(input, cancellation);
				case "sb.entity.copy.execute":
					return await ExecuteCopy(input, emit, cancellation);
				case "sb.entity.copy.result":
					return EntityCopies.GetResult(input.GetProperty("operationId").GetString()!);
				case "sb.entity.rename.review":
					return await ReviewRename(input.GetProperty("operationId").GetString()!, cancellation);
				case "sb.entity.rename.finish":
					return await FinishRename(input, cancellation);
				case "sb.entity.rename.result":
					return EntityCopies.GetRemovalResult(input.GetProperty("operationId").GetString()!);
				case "sb.authorization.connect":
					return await ConnectAuthorization(input, cancellation);
				case "sb.authorization.list":
					return await Authorization.ListAsync(AuthorizationScope(input), cancellation);
				case "sb.authorization.get":
					return await Authorization.GetAsync(AuthorizationScope(input), input.GetProperty("name").GetString()!, cancellation);
				case "sb.authorization.key":
					return await Authorization.KeyAsync(AuthorizationScope(input), input.GetProperty("name").GetString()!, input.GetProperty("keyType").GetString()!, cancellation);
				case "sb.entity.bulk.preview":
					return await PreviewBulkEntities(input, cancellation);
				case "sb.entity.bulk.execute":
					return await ExecuteBulkEntities(input, emit, cancellation);
				case "sb.entity.bulk.result":
					return EntityBulk.GetResult(input.GetProperty("operationId").GetString()!);
				case "sb.purge.bulk.preview":
					return await PreviewBulkPurge(input, cancellation);
				case "sb.purge.bulk":
					return await BulkPurge(input, emit, cancellation);
				case "sb.purge.bulk.result":
					return BulkPurges.GetResult(input.GetProperty("operationId").GetString()!);
				case "sb.test.run":
					return await RunTestJob(input, emit, cancellation);
				case "sb.test.result":
					return TestJobs.GetResult(input.GetProperty("operationId").GetString()!);
				case "sb.receive-delete":
					return await ReceiveDelete(input, emit, cancellation);
				case "sb.receive-delete.result":
					return ReceiveDeletes.GetResult(input.GetProperty("operationId").GetString()!);
				case "sb.purge":
					return await Purge(input, emit, cancellation);
				case "sb.deadletters.resend":
					return await ResendDeadLetters(input, emit, cancellation);
				case "sb.deadletters.result":
					return Recovery.GetResult(input.GetProperty("operationId").GetString()!);
				case "sb.purge.result":
					return Purges.GetResult(input.GetProperty("operationId").GetString()!);
				case "sb.sessions":
					return await Sessions.ListAsync(Target(input), Optional(input, "continuationToken"), cancellation);
				case "sb.sessions.close":
					await Sessions.CloseAsync(Optional(input, "continuationToken"));
					return null;
				case "sb.session.accept":
					return await Interactive.AcceptSessionAsync(new(Target(input), input.GetProperty("sessionId").GetString()!), cancellation);
				case "sb.session.state":
					return await Interactive.GetSessionStateAsync(input.GetProperty("leaseId").GetString()!, cancellation);
				case "sb.session.release":
					await Interactive.ReleaseSessionAsync(input.GetProperty("leaseId").GetString());
					return null;
				case "sb.runtime":
					return await gateway.ListRuntimeAsync(input.GetProperty("kind").GetString()!, Optional(input, "topicName"), Optional(input, "continuationToken"), cancellation);
				case "sb.list":
					return await gateway.ListAsync(input.GetProperty("kind").GetString()!, Optional(input, "topicName"), Optional(input, "continuationToken"), cancellation);
				case "sb.entity":
					return await gateway.GetEntityAsync(Target(input), cancellation);
				case "sb.rules":
					return await gateway.ListRulesAsync(Target(input), Optional(input, "continuationToken"), cancellation);
				case "sb.rule":
					return await gateway.GetRuleAsync(Target(input), input.GetProperty("name").GetString()!, cancellation);
				case "sb.entity-config":
					return await gateway.GetEntityConfigurationAsync(Target(input), cancellation);
				case "sb.scheduled":
					return await Peek(input, cancellation, scheduled: true);
				case "sb.peek":
					return await Peek(input, cancellation);
				case "sb.rule.create":
				case "sb.rule.update":
				case "sb.rule.delete":
				case "sb.authorization.create":
				case "sb.authorization.update":
				case "sb.authorization.delete":
				case "sb.authorization.regenerate":
				case "sb.entity.create":
				case "sb.entity.update":
				case "sb.entity.delete":
				case "sb.session.state.set":
				case "sb.session.renew":
				case "sb.send.batch":
				case "sb.scheduled.cancel":
				case "sb.snapshot.resend":
				case "sb.send":
				case "sb.settle":
				case "sb.replay":
					return await Mutate(method, input, cancellation);
				case "sb.receive":
					return await Receive(input, cancellation);
				case "sb.deliveries":
					return Interactive.CurrentDeliveries();
				case "sb.close-receiver":
					await CloseReceiver();
					return null;
				case "sb.outcome":
					return Receipts.Get(input.GetProperty("operationId").GetString()!);
				case "sb.inspect":
					return Inspection.Inspect(input.GetProperty("snapshotId").GetString()!);
				case "sb.body":
					return Inspection.Body(input.GetProperty("snapshotId").GetString()!, input.GetProperty("offset").GetInt32(), input.GetProperty("count").GetInt32());
				default:
					throw new OperationException(OperationFailure.UnknownOperation, "Unknown Service Bus method.");
			}
		}, cancellation);
	}

	private static string? Optional(JsonElement input, string key) => input.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
	private static EntityTarget Target(JsonElement input) => input.GetProperty("target").Deserialize<EntityTarget>(Json) ?? throw new OperationException(OperationFailure.InvalidInput, "Missing entity.");
	private static ServiceBusOperation Operation(string method) => method switch
	{
		"sb.config.apply" => ServiceBusOperation.ConfigurationWrite,
		"sb.test.run" or "sb.receive-delete" or "sb.receive" or "sb.session.accept" or "sb.purge" or
		"sb.entity.bulk.preview" or "sb.entity.bulk.execute" or "sb.purge.bulk.preview" or "sb.purge.bulk" or
		"sb.deadletters.resend" or "sb.entity.create" or "sb.entity.update" or "sb.entity.delete" or
		"sb.rule.create" or "sb.rule.update" or "sb.rule.delete" or "sb.entity.copy.execute" or "sb.entity.rename.finish" => ServiceBusOperation.ExclusiveMessaging,
		_ => ServiceBusOperation.Shared
	};
	public ValueTask DisposeAsync() => owner.DisposeAsync();
}
