using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MsgCommander.Host;

internal static class RelayRequests
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
	{
		UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
		RespectRequiredConstructorParameters = true
	};
	public static T Read<T>(JsonElement input) => input.Deserialize<T>(Json)!;
	public static ConnectionProfile Profile(JsonElement input) => input.GetProperty("profile").Deserialize<ConnectionProfile>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
	public static RelayManagementConnect Connect(JsonElement input) => new(input.GetProperty("operationId").GetString()!, Profile(input), Read<RelayManagement>(input.GetProperty("management")));
	public static string Fingerprint(JsonElement input) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input.GetRawText())));
	public static RelayTarget Target(JsonElement input)
	{
		var target = Read<RelayTarget>(input.GetProperty("target"));
		target.Validate();
		return target;
	}
}
