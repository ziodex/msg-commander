using System.Collections.ObjectModel;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MsgCommander.Host;

public static class NotificationHubRequests
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow, RespectRequiredConstructorParameters = true };
	private static readonly JsonSerializerOptions ProfileJson = new(JsonSerializerDefaults.Web);
	public static string Fingerprint(JsonElement input) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(input.GetRawText())));
	public static NotificationHubManagementConnect Connect(JsonElement input) => new(input.GetProperty("operationId").GetString()!, input.GetProperty("profile").Deserialize<ConnectionProfile>(ProfileJson)!, input.GetProperty("management").Deserialize<NotificationHubManagement>(Json)!);
	public static NotificationHubTarget Target(JsonElement input)
	{
		var target = input.GetProperty("target").Deserialize<NotificationHubTarget>(Json)!;
		target.Validate();
		return target;
	}
	public static NotificationHubScope Scope(JsonElement input) => input.GetProperty("scope").Deserialize<NotificationHubScope>(Json)!;
	public static NotificationHubChange Change(JsonElement input) => input.Deserialize<NotificationHubChange>(Json)!;
	public static NotificationHubConfigApply Apply(JsonElement input) => input.Deserialize<NotificationHubConfigApply>(Json)!;
	public static NotificationHubCredentialImport Import(JsonElement input) => input.Deserialize<NotificationHubCredentialImport>(Json)!;
	public static NotificationHubCredentialChange CredentialChange(JsonElement input) => input.Deserialize<NotificationHubCredentialChange>(Json)!;
	public static ProviderCredentialDraft Draft(JsonElement input)
	{
		if (input.ValueKind != JsonValueKind.Object)
			throw new OperationException(OperationFailure.InvalidInput, "Invalid provider credential draft.");
		var names = input.EnumerateObject().Select(p => p.Name).ToArray();
		if (names.Distinct(StringComparer.Ordinal).Count() != names.Length)
			throw new OperationException(OperationFailure.InvalidInput, "Use exactly the fields for the selected notification provider.");
		var provider = input.GetProperty("provider").GetString()!;
		bool? remove = null;
		if (input.TryGetProperty("remove", out var value))
		{
			if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
				throw new OperationException(OperationFailure.InvalidInput, "Review removal of exactly one provider; replacement credentials cannot accompany removal.");
			remove = value.GetBoolean();
		}
		var fields = input.EnumerateObject().Where(p => p.Name is not ("provider" or "remove")).ToDictionary(p => p.Name, p => p.Value.GetString(), StringComparer.Ordinal);
		return new(provider, remove, new ReadOnlyDictionary<string, string?>(fields));
	}
}
