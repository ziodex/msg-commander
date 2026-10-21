using MsgCommander.Application.Common;
using MsgCommander.Application.NotificationHubs.Management;
using MsgCommander.Contracts.NotificationHubs.Management;

namespace MsgCommander.Application.NotificationHubs.Credentials;

public static class NotificationHubCredentialRules
{
	public static void Provider(string provider)
	{
		if (provider is not ("apns-token" or "apns-certificate" or "fcm-v1" or "wns" or "adm" or "baidu" or "mpns-certificate" or "browser" or "xiaomi" or "gcm-legacy"))
			throw new OperationException(OperationFailure.InvalidInput, "Select a supported notification provider.");
	}
	public static void Hub(NotificationHubTarget target)
	{
		target.Validate();
		if (target.Scope.Kind != "hub" || target.PolicyName is not null)
			throw new OperationException(OperationFailure.InvalidInput, "Select a Notification Hub before configuring a provider.");
	}
	public static OperationException InvalidImport() => new(OperationFailure.InvalidInput, "The credential file is invalid, expired, not yet valid, uses an unsupported key, or its password is incorrect. Import an APNS P-256 PKCS#8 .p8 key, an FCM v1 RSA service-account JSON, or a P12/PFX/PEM bundle with one valid leaf certificate and its matching private key.");
	public static IReadOnlyList<string> Fields(ProviderCredentialDraft draft)
	{
		Provider(draft.Provider);
		if (draft.Remove is not null)
		{
			if (draft.Remove != true || draft.Fields.Count != 0)
				throw new OperationException(OperationFailure.InvalidInput, "Review removal of exactly one provider; replacement credentials cannot accompany removal.");
			return [];
		}
		if (draft.Provider == "gcm-legacy")
			throw new OperationException(OperationFailure.InvalidInput, "GCM/FCM legacy is retired. Import FCM v1 credentials and migrate registrations/payloads; legacy credentials can only be removed.");
		string[] fields = draft.Provider switch
		{
			"apns-token" => ["artifactId", "environment", "keyId", "teamId", "bundleId"],
			"apns-certificate" => ["artifactId", "environment"],
			"mpns-certificate" or "fcm-v1" => ["artifactId"],
			"wns" => ["packageSid", "secretKey"],
			"adm" => ["clientId", "clientSecret"],
			"browser" => ["subject", "vapidPublicKey", "vapidPrivateKey"],
			"xiaomi" => ["appSecret", "endpoint"],
			_ => ["apiKey", "secretKey"]
		};
		if (!draft.Fields.Keys.Order().SequenceEqual(fields.Order()))
			throw new OperationException(OperationFailure.InvalidInput, "Use exactly the fields for the selected notification provider.");
		return fields;
	}
	public static string Value(ProviderCredentialDraft draft, string name)
	{
		var value = draft.Fields[name];
		if (value is null || value.Length is < 1 or > 8192 || string.IsNullOrWhiteSpace(value) || value.Any(char.IsControl))
			throw new OperationException(OperationFailure.InvalidInput, "Enter non-empty provider credentials without control characters.");
		return value;
	}
}
