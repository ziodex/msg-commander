using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace MsgCommander.Host;

public sealed partial class ServiceBusWorkspace
{
	private Task<OperationOutcome> Mutate(string method, JsonElement input, CancellationToken cancellation)
	{
		var operationId = input.GetProperty("id").GetString()!;
		var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(method + input.GetRawText())));
		var scope = method.StartsWith("sb.authorization.", StringComparison.Ordinal) ? MutationScope.Authorization :
			method.StartsWith("sb.rule.", StringComparison.Ordinal) ? MutationScope.Rule :
			method.StartsWith("sb.entity.", StringComparison.Ordinal) ? MutationScope.Entity : MutationScope.Messaging;
		var kind = method == "sb.session.state.set" ? InteractiveMutation.SessionState :
			method == "sb.session.renew" ? InteractiveMutation.SessionRenew : InteractiveMutation.Other;
		return Receipts.ExecuteAsync(operationId, fingerprint, scope, async execution =>
		{
			if (scope == MutationScope.Authorization)
			{
				var action = method[17..];
				await ChangeAuthorization(action, input, execution.Dispatch, cancellation);
				return new($"Azure management acknowledged SAS rule {action}. Clients using removed rights or an old key may lose access. Saved connection profiles were not changed.");
			}
			if (scope == MutationScope.Rule)
			{
				var target = Target(input);
				var name = input.GetProperty("name").GetString()!;
				var action = method[8..];
				await EntityAdministration.ChangeRuleAsync(new(action, target, name,
					action == "delete" ? null : input.GetProperty("definition").Deserialize<RuleDefinition>(Json),
					Optional(input, "expectedRevision"), Optional(input, "confirmation")), execution.Dispatch, cancellation);
				return new($"Broker acknowledged rule {action}: {SubscriptionRules.Path(target, name)}. Existing stored messages are unchanged.");
			}
			if (scope == MutationScope.Entity)
			{
				var target = Target(input);
				var action = method[10..];
				await EntityAdministration.ChangeEntityAsync(new(action, target,
					action == "delete" ? null : input.GetProperty("settings").Deserialize<EntitySettings>(Json),
					Optional(input, "expectedRevision"), Optional(input, "confirmation")), execution.Dispatch, cancellation);
				return new($"Broker acknowledged entity {action}: {EntityManagement.Path(target)}.");
			}
			switch (method)
			{
				case "sb.session.state.set":
					await Interactive.ChangeSessionStateAsync(new(input.GetProperty("leaseId").GetString()!, input.GetProperty("bodyBase64").GetString(),
						Optional(input, "confirmation"), input.GetProperty("expectedRevision").GetString()!), execution.Dispatch, cancellation);
					return new("Broker acknowledged session state update. No messages were received or settled.");
				case "sb.session.renew":
					await Interactive.RenewSessionAsync(input.GetProperty("leaseId").GetString(), execution.Dispatch, cancellation);
					return new("Broker acknowledged session lock renewal, including locks for its held messages.");
				case "sb.send.batch":
					var drafts = input.GetProperty("drafts");
					if (drafts.GetArrayLength() is < 1 or > 20 || Encoding.UTF8.GetByteCount(drafts.GetRawText()) > 524288)
						throw new OperationException(OperationFailure.InvalidInput, "Use 1–20 messages and at most 512 KiB of serialized drafts per batch.");
					var schedule = input.GetProperty("scheduledEnqueueTime");
					if (schedule.ValueKind is not (JsonValueKind.Null or JsonValueKind.String))
						throw new OperationException(OperationFailure.InvalidInput, "Scheduled enqueue time must be a timestamp or null for immediate sending.");
					return await Sending.SendBatchAsync(new(Target(input), drafts.Deserialize<MessageDraft[]>(Json)!, schedule.GetString()), execution, cancellation);
				case "sb.scheduled.cancel":
					return await Sending.CancelScheduledAsync(new(Target(input), input.GetProperty("sequenceNumbers").Deserialize<string[]>(Json)!, input.GetProperty("confirmation").GetString()!), execution, cancellation);
				case "sb.snapshot.resend":
					return await Sending.ResendAsync(new(input.GetProperty("snapshotId").GetString()!, input.GetProperty("destination").Deserialize<EntityTarget>(Json)!,
						input.GetProperty("idPolicy").GetString()!, input.GetProperty("messageId").GetString()!), execution, cancellation);
				case "sb.send":
					return await Sending.SendAsync(new(Target(input), input.GetProperty("draft").Deserialize<MessageDraft>(Json) ??
						throw new OperationException(OperationFailure.InvalidInput, "Missing draft.")), execution, cancellation);
				case "sb.replay":
					return await Interactive.ReplayAsync(new(input.GetProperty("deliveryId").GetString()!, input.GetProperty("destination").Deserialize<EntityTarget>(Json)!,
						input.GetProperty("idPolicy").GetString()!, input.GetProperty("messageId").GetString()!), execution, cancellation);
				default:
					return await Interactive.SettleAsync(new(input.GetProperty("deliveryId").GetString()!, input.GetProperty("action").GetString()!,
						input.GetProperty("reason").GetString()!, input.GetProperty("description").GetString()!), execution, cancellation);
			}
		}, (execution, failure, status) => Interactive.ObserveMutationFailure(kind, execution, failure, status), cancellation);
	}
}
