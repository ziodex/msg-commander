using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MsgCommander.Host;

public static class EventHubsRequests
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	private static readonly JsonSerializerOptions Strict = new(JsonSerializerDefaults.Web) { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow, RespectRequiredConstructorParameters = true };
	public static string Fingerprint(JsonElement input) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input.GetRawText())));
	public static EventHubConnect Connect(JsonElement input) => new(input.GetProperty("profile").Deserialize<ConnectionProfile>(Json)!,
		input.GetProperty("hubName").GetString()!, input.TryGetProperty("access", out var access) ? access.GetString()! : "read",
		input.GetProperty("management").Deserialize<EventHubsManagementContext>(Json));
	private static void Fields(JsonElement input, params string[] names)
	{
		if (!input.EnumerateObject().Select(p => p.Name).Order().SequenceEqual(names.Order()))
			throw new OperationException(OperationFailure.InvalidInput, "Use an explicit event position with only its applicable settings.");
	}
	public static EventPositionSpec Position(JsonElement input)
	{
		var kind = input.GetProperty("kind").GetString()!;
		if (kind is "earliest" or "latest")
		{
			Fields(input, "kind");
			return new(kind);
		}
		if (kind == "time")
		{
			Fields(input, "kind", "value");
			return new(kind, input.GetProperty("value").GetString());
		}
		Fields(input, "kind", "value", "inclusive");
		return new(kind, input.GetProperty("value").GetString(), input.GetProperty("inclusive").GetBoolean());
	}
	public static EventRouting Routing(JsonElement input)
	{
		var kind = input.GetProperty("kind").GetString()!;
		if (kind == "automatic")
		{
			Fields(input, "kind");
			return new(kind);
		}
		Fields(input, "kind", "value");
		return new(kind, input.GetProperty("value").GetString());
	}
	public static EventHubReadRequest Read(JsonElement input) => new(input.GetProperty("id").GetString()!, input.GetProperty("hubName").GetString()!,
		input.GetProperty("consumerGroup").GetString()!, input.GetProperty("partitionId").GetString()!, Position(input.GetProperty("position")),
		input.GetProperty("maxEvents").GetInt32(), input.GetProperty("maxSeconds").GetInt32());
	public static EventHubSendRequest Send(JsonElement input)
	{
		if (input.EnumerateObject().Any(p => p.Name is not ("id" or "connectionId" or "hubName" or "routing" or "drafts" or "repetitions" or "batchSize" or "maxSeconds" or "delayMs" or "acknowledged")))
			throw new OperationException(OperationFailure.InvalidInput, "Unsupported send setting.");
		var raw = input.GetProperty("drafts");
		if (raw.GetArrayLength() is < 1 or > 20 || Encoding.UTF8.GetByteCount(raw.GetRawText()) > 524288)
			throw new OperationException(OperationFailure.InvalidInput, "Use 1–20 drafts and at most 512 KiB of serialized drafts.");
		foreach (var draft in raw.EnumerateArray())
			if (draft.EnumerateObject().Any(p => p.Name is not ("bodyBase64" or "contentType" or "correlationId" or "properties")) || draft.GetProperty("properties").EnumerateArray().Any(p => p.EnumerateObject().Any(k => k.Name is not ("name" or "type" or "value"))))
				throw new OperationException(OperationFailure.InvalidInput, "Unsupported draft field.");
		return new(input.GetProperty("id").GetString()!, input.GetProperty("hubName").GetString()!, Routing(input.GetProperty("routing")), raw.Deserialize<EventDraft[]>(Json)!,
			input.GetProperty("repetitions").GetInt32(), input.GetProperty("batchSize").GetInt32(), input.GetProperty("maxSeconds").GetInt32(), input.GetProperty("delayMs").GetInt32(), input.GetProperty("acknowledged").ValueKind == JsonValueKind.True);
	}
	public static EventListenRequest Listen(JsonElement input)
	{
		var start = input.GetProperty("start");
		if (start.GetProperty("kind").GetString() == "checkpoint")
		{
			Fields(start, "kind", "checkpoint");
			foreach (var partition in start.GetProperty("checkpoint").GetProperty("partitions").EnumerateArray())
				Position(partition.GetProperty("position"));
		}
		else
			Position(start);
		return input.Deserialize<EventListenRequest>(Strict)!;
	}
	public static EventAdminTarget AdminTarget(JsonElement input)
	{
		var target = input.GetProperty("target").Deserialize<EventAdminTarget>(Strict)!;
		target.Validate();
		return target;
	}
	public static EventAdminChange AdminChange(JsonElement input) => input.Deserialize<EventAdminChange>(Strict)!;
}
