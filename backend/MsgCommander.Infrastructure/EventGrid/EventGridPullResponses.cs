using System.Text;
using System.Text.Json;

namespace MsgCommander.Infrastructure.EventGrid;

internal static class EventGridPullResponses
{
	public static EventGridReceiveBatch Receive(JsonElement response, int maximum, object issuer)
	{
		if (!response.TryGetProperty("value", out var items) || items.ValueKind != JsonValueKind.Array || items.GetArrayLength() > maximum)
			throw new IOException("Invalid receive result.");
		var events = new List<EventGridDeliveryEnvelope>();
		foreach (var row in items.EnumerateArray())
		{
			var broker = row.GetProperty("brokerProperties");
			var token = broker.GetProperty("lockToken").GetString();
			var count = broker.GetProperty("deliveryCount").GetInt32();
			var value = row.GetProperty("event");
			if (string.IsNullOrEmpty(token) || token.Length > 16384 || count < 1 || value.ValueKind != JsonValueKind.Object)
				throw new IOException("Invalid receive result.");
			var raw = value.GetRawText();
			if (Encoding.UTF8.GetByteCount(raw) > 1048576)
				throw new IOException("Oversized CloudEvent.");
			events.Add(new(new(issuer, token), count, raw));
		}
		return new(events.ToArray());
	}
	public static EventGridSettlementBatch Settlement(JsonElement response, object issuer)
	{
		var success = response.GetProperty("succeededLockTokens");
		var failure = response.GetProperty("failedLockTokens");
		if (success.ValueKind != JsonValueKind.Array || failure.ValueKind != JsonValueKind.Array || success.GetArrayLength() + failure.GetArrayLength() > 100)
			throw new IOException("Invalid settlement result.");
		var succeeded = success.EnumerateArray().Select(item => new EventGridLockToken(issuer, item.GetString()!)).ToArray();
		var failed = failure.EnumerateArray().Select(item =>
		{
			// The stable REST response nests errors; earlier samples also used errorCode.
			string? code = item.TryGetProperty("error", out var error) && error.TryGetProperty("code", out var nested) ? nested.GetString()
				: item.TryGetProperty("errorCode", out var flat) ? flat.GetString() : null;
			var safe = code is "BadToken" or "TokenLost" or "LockLost" or "LockTokenExpired" or "Unauthorized" or "TooManyRequests" ? code : "SettlementFailed";
			return new EventGridTokenFailure(new(issuer, item.GetProperty("lockToken").GetString()!), Enum.Parse<EventGridSettlementFailureCode>(safe));
		}).ToArray();
		return new(succeeded, failed);
	}
}
