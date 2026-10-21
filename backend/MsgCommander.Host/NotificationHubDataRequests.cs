using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MsgCommander.Host;

internal static class NotificationHubDataRequests
{
	public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
	{
		UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
		RespectRequiredConstructorParameters = true
	};
	public static T Read<T>(JsonElement input) => input.Deserialize<T>(Json)!;
	public static string? String(JsonElement input, string name) => input.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
	public static NotificationHubDataConnect Connect(JsonElement input) => new(Read<NotificationHubRegistrationsConnect>(input.GetProperty("request")), input.GetProperty("profile").Deserialize<ConnectionProfile>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!);
	public static string Fingerprint<T>(T input) => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(input, Json)));
	public static string RawFingerprint(JsonElement input) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input.GetRawText())));
}
