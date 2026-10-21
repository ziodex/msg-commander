using MsgCommander.Application.EventGrid.Administration;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MsgCommander.Host;

public static class EventGridRequests
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow, RespectRequiredConstructorParameters = true };
	private static readonly JsonSerializerOptions ProfileJson = new(JsonSerializerDefaults.Web);
	public static string Fingerprint(JsonElement input) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input.GetRawText())));
	public static EventGridConnect Connect(JsonElement input) => new(input.GetProperty("profile").Deserialize<ConnectionProfile>(ProfileJson)!, input.GetProperty("management").Deserialize<EventGridManagement>(Json)!);
	public static EventGridTarget Target(JsonElement input) => input.GetProperty("target").Deserialize<EventGridTarget>(Json)!;
	public static EventGridReceive Receive(JsonElement input) => input.Deserialize<EventGridReceive>(Json)!;
	public static EventGridSettle Settle(JsonElement input) => input.Deserialize<EventGridSettle>(Json)!;
	public static EventGridCommand Change(JsonElement input) => EventGridCommands.Prepare(input.Deserialize<EventGridAdminChange>(Json)!);
	public static EventGridPublish Publish(JsonElement input)
	{
		if (Encoding.UTF8.GetByteCount(input.GetRawText()) > 524288)
			throw new OperationException(OperationFailure.InvalidInput, "Use at most 512 KiB per publish job. Nothing was sent.");
		return input.Deserialize<EventGridPublish>(Json) ?? throw new OperationException(OperationFailure.InvalidInput, "Invalid publish job.");
	}
}
