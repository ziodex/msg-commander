using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
namespace MsgCommander.Infrastructure.NotificationHubs;

internal sealed class AzureProviderCredentialMaterial(string provider, JsonObject properties) : ProviderCredentialMaterial(provider)
{
	internal JsonObject Properties { get; } = properties;
}
public sealed class AzureProviderCredentialCodec : IProviderCredentialCodec
{
	public ImportedProviderCredential Import(string provider, byte[] bytes, string password)
	{
		var (properties, summary, notAfter) = NotificationHubCredentials.Import(provider, bytes, password);
		return new(new AzureProviderCredentialMaterial(provider, properties), summary, notAfter);
	}
	public ProviderCredentialMaterial Build(ProviderCredentialDraft draft, ProviderCredentialMaterial? imported)
	{
		NotificationHubCredentialRules.Fields(draft);
		var provider = draft.Provider;
		string Value(string name) => NotificationHubCredentialRules.Value(draft, name);
		var p = imported switch
		{
			null => new JsonObject(),
			AzureProviderCredentialMaterial data when data.Provider == provider => data.Properties.DeepClone().AsObject(),
			_ => throw new OperationException(OperationFailure.InvalidInput, "Credential import belongs to another provider or codec.")
		};
		if (provider.StartsWith("apns-", StringComparison.Ordinal))
		{
			var environment = Value("environment");
			if (environment is not ("production" or "sandbox"))
				throw new OperationException(OperationFailure.InvalidInput, "Choose the APNS environment.");
			// Explicitly clear the incompatible APNS authentication mode when replacing the provider object.
			foreach (var field in new[] { "apnsCertificate", "certificateKey", "thumbprint", "keyId", "appName", "appId", "token" })
				if (!p.ContainsKey(field))
					p[field] = null;
			p["endpoint"] = provider == "apns-token" ? (environment == "production" ? "https://api.push.apple.com:443/3/device" : "https://api.development.push.apple.com:443/3/device") : (environment == "production" ? "gateway.push.apple.com" : "gateway.sandbox.push.apple.com");
			if (provider == "apns-token")
			{
				var key = Value("keyId");
				var team = Value("teamId");
				var bundle = Value("bundleId");
				if (!Regex.IsMatch(key, "^[A-Z0-9]{10}$") || !Regex.IsMatch(team, "^[A-Z0-9]{10}$") || bundle.Length > 255 || !Regex.IsMatch(bundle, "^[A-Za-z0-9.-]+$"))
					throw new OperationException(OperationFailure.InvalidInput, "Use a 10-character APNS Key ID and Team ID, and an application Bundle ID.");
				p["keyId"] = key;
				p["appId"] = team;
				p["appName"] = bundle;
			}
		}
		else if (provider == "wns")
		{
			p["packageSid"] = Value("packageSid");
			p["secretKey"] = Value("secretKey");
			p["windowsLiveEndpoint"] = "https://login.live.com/accesstoken.srf";
		}
		else if (provider == "adm")
		{
			p["clientId"] = Value("clientId");
			p["clientSecret"] = Value("clientSecret");
			p["authTokenUrl"] = "https://api.amazon.com/auth/O2/token";
		}
		else if (provider == "baidu")
		{
			p["baiduApiKey"] = Value("apiKey");
			p["baiduSecretKey"] = Value("secretKey");
			p["baiduEndPoint"] = "https://channel.api.duapp.com/rest/2.0/channel/channel";
		}
		else if (provider == "browser")
		{
			var subject = Value("subject");
			var pub = Value("vapidPublicKey");
			var key = Value("vapidPrivateKey");
			NotificationHubCredentials.ValidateBrowser(subject, pub, key);
			p["subject"] = subject;
			p["vapidPublicKey"] = pub;
			p["vapidPrivateKey"] = key;
		}
		else if (provider == "xiaomi")
		{
			var endpoint = Value("endpoint");
			if (endpoint.Length > 2048 || !Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo != "" || uri.Query != "" || uri.Fragment != "" || !Regex.IsMatch(uri.Host, @"^(?:api|api-[a-z]{2})\.xmpush\.xiaomi\.com$") || uri.AbsolutePath != "/v3/message/regid")
				throw new OperationException(OperationFailure.InvalidInput, "Use an HTTPS Xiaomi regional endpoint ending in /v3/message/regid.");
			p["appSecret"] = Value("appSecret");
			p["endpoint"] = endpoint;
		}
		return new AzureProviderCredentialMaterial(provider, p);

	}
}
