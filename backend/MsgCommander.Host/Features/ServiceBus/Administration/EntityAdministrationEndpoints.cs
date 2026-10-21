using System.Security.Cryptography;
using System.Text.Json;
using MsgCommander.Application.ServiceBus.Administration;

namespace MsgCommander.Host;

public sealed partial class ServiceBusWorkspace
{
	private static string CopyStamp(object value) => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, Json)));
	private Task<BulkEntityPlan> PreviewBulkEntities(JsonElement input, CancellationToken cancellation) =>
		EntityBulk.PreviewAsync(new(input.GetProperty("targets").Deserialize<EntityTarget[]>(Json),
			input.GetProperty("action").Deserialize<BulkEntityAction>(Json), input.GetProperty("maxSeconds").GetInt32()), cancellation);
	private Task<BulkEntityResult> ExecuteBulkEntities(JsonElement input, Func<object, Task> emit, CancellationToken cancellation) =>
		EntityBulk.ExecuteAsync(new(input.GetProperty("id").GetString()!, input.GetProperty("planId").GetString()!,
			input.GetProperty("confirmation").GetString()!), CopyStamp(input), progress => emit(progress), cancellation);

	private Task<EntityCopyPreview> PreviewCopy(JsonElement input, CancellationToken cancellation) =>
		EntityCopies.PreviewAsync(input.GetProperty("spec").Deserialize<EntityCopySpec>(Json) ??
			throw new OperationException(OperationFailure.InvalidInput, "Missing copy specification."), cancellation);
	private Task<EntityCopyResult> ExecuteCopy(JsonElement input, Func<object, Task> emit, CancellationToken cancellation) =>
		EntityCopies.ExecuteAsync(new(input.GetProperty("id").GetString()!, input.GetProperty("planId").GetString()!,
			input.GetProperty("confirmation").GetString()!), CopyStamp(input), progress => emit(progress), cancellation);
	private Task<RenameReview> ReviewRename(string operationId, CancellationToken cancellation) => EntityCopies.ReviewRenameAsync(operationId, cancellation);
	private Task<OperationOutcome> FinishRename(JsonElement input, CancellationToken cancellation) =>
		EntityCopies.FinishRenameAsync(new(input.GetProperty("id").GetString()!, input.GetProperty("reviewId").GetString()!,
			input.GetProperty("confirmation").GetString()!), CopyStamp(input), cancellation);
}
