using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MsgCommander.Application.ServiceBus.Maintenance;
using MsgCommander.Contracts.ServiceBus.Maintenance;

namespace MsgCommander.Host;

public sealed partial class ServiceBusWorkspace
{
	private static PurgeCutoffInput ReadPurgeCutoff(JsonElement input) => input.TryGetProperty("beforeEnqueueTime", out var cutoff)
		? new(true, cutoff.ValueKind == JsonValueKind.String ? cutoff.GetString() : null) : new(false, null);
	private static string RawRequestStamp(JsonElement input) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input.GetRawText())));
	private Task<PurgeResult> Purge(JsonElement input, Func<object, Task> emit, CancellationToken cancellation)
	{
		var id = input.GetProperty("id").GetString()!;
		var fingerprint = RawRequestStamp(input);
		if (Purges.CheckRequest(id, fingerprint) is { } previous)
			return Task.FromResult(previous);
		return Purges.ExecuteAsync(new(id, Target(input), input.GetProperty("subQueue").GetString()!,
			input.GetProperty("maxMessages").GetInt32(), input.GetProperty("maxSeconds").GetInt32(), input.GetProperty("confirmation").GetString()!,
			ReadPurgeCutoff(input)), fingerprint, progress => emit(progress), cancellation);
	}
	private Task<ReceiveDeleteResult> ReceiveDelete(JsonElement input, Func<object, Task> emit, CancellationToken cancellation)
	{
		var id = input.GetProperty("id").GetString()!;
		var fingerprint = RawRequestStamp(input);
		if (ReceiveDeletes.CheckRequest(id, fingerprint) is { } previous)
			return Task.FromResult(previous);
		return ReceiveDeletes.ExecuteAsync(new(id, Target(input), input.GetProperty("subQueue").GetString()!, input.GetProperty("sessionId").GetString()!,
			input.GetProperty("maxMessages").GetInt32(), input.GetProperty("maxSeconds").GetInt32(), input.GetProperty("confirmation").GetString()!),
			fingerprint, progress => emit(progress), cancellation);
	}
	private Task<BulkPurgePlan> PreviewBulkPurge(JsonElement input, CancellationToken cancellation) =>
		BulkPurges.PreviewAsync(new(input.GetProperty("targets").Deserialize<BulkPurgeTarget[]>(Json), input.GetProperty("maxPerTarget").GetInt32(),
			input.GetProperty("maxTotal").GetInt32(), input.GetProperty("maxSeconds").GetInt32(), ReadPurgeCutoff(input)), cancellation);
	private Task<BulkPurgeResult> BulkPurge(JsonElement input, Func<object, Task> emit, CancellationToken cancellation)
	{
		var id = input.GetProperty("id").GetString()!;
		var fingerprint = CopyStamp(input);
		if (BulkPurges.CheckRequest(id, fingerprint) is { } previous)
			return Task.FromResult(previous);
		return BulkPurges.ExecuteAsync(new(id, input.GetProperty("planId").GetString()!, input.GetProperty("confirmation").GetString()!,
			input.TryGetProperty("beforeEnqueueTime", out _)), fingerprint, progress => emit(progress), cancellation);
	}
	private Task<ResendResult> ResendDeadLetters(JsonElement input, Func<object, Task> emit, CancellationToken cancellation)
	{
		var id = input.GetProperty("id").GetString()!;
		// Saved destination credentials are resolved only in main and excluded from fingerprints and receipts.
		var publicInput = input.EnumerateObject().Where(property => property.Name != "destinationProfile").ToDictionary(property => property.Name, property => property.Value);
		var fingerprint = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(publicInput)));
		if (Recovery.CheckRequest(id, fingerprint) is { } previous)
			return Task.FromResult(previous);
		RecoveryDestination? cross = null;
		if (input.TryGetProperty("destinationProfileId", out _) || input.TryGetProperty("destinationNamespace", out _) || input.TryGetProperty("destinationProfile", out _))
			cross = new(Optional(input, "destinationProfileId"), Optional(input, "destinationNamespace"),
				input.TryGetProperty("destinationProfile", out var profile) ? profile.Deserialize<ConnectionProfile>(Json) : null,
				input.TryGetProperty("acknowledgeNonAtomic", out var acknowledged) && acknowledged.ValueKind == JsonValueKind.True);
		return Recovery.ExecuteAsync(new(id, input.GetProperty("source").Deserialize<EntityTarget>(Json)!, Optional(input, "subQueue") ?? "dead-letter",
			input.GetProperty("destination").Deserialize<EntityTarget>(Json)!, input.GetProperty("mode").GetString()!, input.GetProperty("idPolicy").GetString()!,
			input.GetProperty("maxMessages").GetInt32(), input.GetProperty("maxSeconds").GetInt32(), cross), fingerprint,
			progress => emit(progress), code => emit(new { type = "device-code", operationId = id, code = code.Code, expiresOn = code.ExpiresOn }), cancellation);
	}
}
