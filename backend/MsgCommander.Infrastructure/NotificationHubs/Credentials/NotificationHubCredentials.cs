using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Azure;
using Azure.Core;
namespace MsgCommander.Infrastructure.NotificationHubs;

public static class NotificationHubCredentials
{
	public static string Property(string provider) => provider switch { "apns-token" or "apns-certificate" => "apnsCredential", "fcm-v1" => "fcmV1Credential", "wns" => "wnsCredential", "adm" => "admCredential", "baidu" => "baiduCredential", "mpns-certificate" => "mpnsCredential", "browser" => "browserCredential", "xiaomi" => "xiaomiCredential", "gcm-legacy" => "gcmCredential", _ => throw new OperationException(OperationFailure.InvalidInput, "Select a supported notification provider.") };
	public static string Version(string provider) => provider == "fcm-v1" ? "2023-10-01-preview" : AzureNotificationHubGateway.ApiVersion;
	public static void Hub(NotificationHubTarget target)
	{
		target.Validate();
		if (target.Scope.Kind != "hub" || target.PolicyName is not null)
			throw new OperationException(OperationFailure.InvalidInput, "Select a Notification Hub before configuring a provider.");
	}
	public static OperationException Invalid() => new(OperationFailure.InvalidInput, "The credential file is invalid, expired, not yet valid, uses an unsupported key, or its password is incorrect. Import an APNS P-256 PKCS#8 .p8 key, an FCM v1 RSA service-account JSON, or a P12/PFX/PEM bundle with one valid leaf certificate and its matching private key.");
	private static byte[] CertificatePem(string text, string password)
	{
		List<X509Certificate2> certificates = [];
		List<AsymmetricAlgorithm> keys = [];
		try
		{
			var remaining = text.AsSpan();
			while (!remaining.Trim().IsEmpty)
			{
				if (certificates.Count + keys.Count >= 32 || !PemEncoding.TryFind(remaining, out var found) || !remaining[..found.Location.Start.GetOffset(remaining.Length)].Trim().IsEmpty)
					throw Invalid();
				var label = remaining[found.Label].ToString();
				var block = remaining[found.Location].ToString();
				if (label == "CERTIFICATE")
					certificates.Add(X509Certificate2.CreateFromPem(block));
				else if (label is "PRIVATE KEY" or "ENCRYPTED PRIVATE KEY" or "RSA PRIVATE KEY" or "EC PRIVATE KEY")
				{
					AsymmetricAlgorithm? key = null;
					foreach (var candidate in new AsymmetricAlgorithm[] { RSA.Create(), ECDsa.Create() })
					{
						if (key is not null)
						{
							candidate.Dispose();
							continue;
						}
						try
						{
							if (label == "ENCRYPTED PRIVATE KEY")
								candidate.ImportFromEncryptedPem(block, password);
							else
								candidate.ImportFromPem(block);
							key = candidate;
						}
						catch (Exception e) when (e is CryptographicException or ArgumentException) { candidate.Dispose(); }
					}
					if (key is null)
						throw Invalid();
					keys.Add(key);
				}
				else
					throw Invalid();
				remaining = remaining[found.Location.End.GetOffset(remaining.Length)..];
			}
			if (keys.Count != 1 || certificates.Count == 0)
				throw Invalid();
			var contents = new Pkcs12SafeContents();
			foreach (var cert in certificates)
				contents.AddCertificate(cert);
			contents.AddShroudedKey(keys[0], password, new PbeParameters(PbeEncryptionAlgorithm.Aes256Cbc, HashAlgorithmName.SHA256, 10000));
			var builder = new Pkcs12Builder();
			builder.AddSafeContentsUnencrypted(contents);
			builder.SealWithMac(password, HashAlgorithmName.SHA256, 10000);
			return builder.Encode();
		}
		finally { foreach (var cert in certificates) cert.Dispose(); foreach (var key in keys) key.Dispose(); }
	}
	internal static void ValidateBrowser(string subject, string publicKey, string privateKey)
	{
		var invalid = new OperationException(OperationFailure.InvalidInput, "Use a mailto: or HTTPS contact and a matching unpadded base64url P-256 VAPID key pair (65-byte public key, 32-byte private key).");
		if (subject.Length > 2048 || subject.Any(char.IsWhiteSpace) || !Uri.TryCreate(subject, UriKind.Absolute, out var contact) || !(contact.Scheme == "https" && contact.Host != "" && contact.UserInfo == "" && contact.Fragment == "" || contact.Scheme == "mailto" && Regex.IsMatch(subject, @"^mailto:[^@\s?#]+@[^@\s?#]+\.[^@\s?#]+$")) || !Regex.IsMatch(publicKey, @"^[A-Za-z0-9_-]{87}$") || !Regex.IsMatch(privateKey, @"^[A-Za-z0-9_-]{43}$"))
			throw invalid;
		byte[]? d = null;
		try
		{
			var q = Convert.FromBase64String(publicKey.Replace('-', '+').Replace('_', '/') + "=");
			d = Convert.FromBase64String(privateKey.Replace('-', '+').Replace('_', '/') + "=");
			string Encode(byte[] v) => Convert.ToBase64String(v).TrimEnd('=').Replace('+', '-').Replace('/', '_');
			if (q.Length != 65 || q[0] != 4 || d.Length != 32 || Encode(q) != publicKey || Encode(d) != privateKey)
				throw invalid;
			var parameters = new ECParameters { Curve = ECCurve.NamedCurves.nistP256, Q = new() { X = q[1..33], Y = q[33..] } };
			using var verification = ECDsa.Create(parameters);
			parameters.D = d;
			using var key = ECDsa.Create(parameters);
			var probe = RandomNumberGenerator.GetBytes(32);
			if (!verification.VerifyHash(probe, key.SignHash(probe)))
				throw invalid;
		}
		catch (Exception e) when (e is CryptographicException or FormatException or ArgumentException) { throw invalid; }
		finally { if (d is not null) CryptographicOperations.ZeroMemory(d); }
	}
	internal static (JsonObject Properties, string Summary, DateTimeOffset? NotAfter) Import(string provider, byte[] bytes, string password)
	{
		try
		{
			if (bytes.Length is < 1 or > 262144 || password.Length > 1024)
				throw Invalid();
			if (provider == "apns-token")
			{
				if (password != "")
					throw Invalid();
				var text = new UTF8Encoding(false, true).GetString(bytes).Trim();
				// Only a single unencrypted PKCS#8 private key is accepted, not a public key or a key/certificate bundle.
				if (!text.StartsWith("-----BEGIN PRIVATE KEY-----", StringComparison.Ordinal) || !text.EndsWith("-----END PRIVATE KEY-----", StringComparison.Ordinal) || text.Split("-----BEGIN", StringSplitOptions.None).Length != 2)
					throw Invalid();
				using var key = ECDsa.Create();
				key.ImportFromPem(text);
				var parameters = key.ExportParameters(false);
				if (key.KeySize != 256 || parameters.Curve.Oid.Value != "1.2.840.10045.3.1.7")
					throw Invalid();
				return (new()
				{
					["token"] = Convert.ToBase64String(key.ExportPkcs8PrivateKey())
				}, "P-256 private key validated locally; Apple account ownership is checked by Azure/APNS.", null);
			}
			if (provider == "fcm-v1")
			{
				if (password != "")
					throw Invalid();
				using var doc = JsonDocument.Parse(bytes, new()
				{
					MaxDepth = 8
				});
				var root = doc.RootElement;
				if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Select(p => p.Name).Distinct(StringComparer.Ordinal).Count() != root.EnumerateObject().Count() || root.GetProperty("type").GetString() != "service_account")
					throw Invalid();
				var project = root.GetProperty("project_id").GetString()!;
				var email = root.GetProperty("client_email").GetString()!;
				var pem = root.GetProperty("private_key").GetString()!;
				if (!Regex.IsMatch(project, "^[a-z][a-z0-9-]{4,61}[a-z0-9]$", RegexOptions.CultureInvariant) || email.Length > 320 || !Regex.IsMatch(email, "^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.iam\\.gserviceaccount\\.com$", RegexOptions.CultureInvariant) || pem.Length > 16384 || !pem.Trim().StartsWith("-----BEGIN PRIVATE KEY-----", StringComparison.Ordinal) || pem.Split("-----BEGIN", StringSplitOptions.None).Length != 2)
					throw Invalid();
				using var key = RSA.Create();
				key.ImportFromPem(pem);
				if (key.KeySize < 2048)
					throw Invalid();
				return (new()
				{
					["projectId"] = project,
					["clientEmail"] = email,
					["privateKey"] = key.ExportPkcs8PrivateKeyPem()
				}, "RSA service-account key validated locally; FCM v1 uses ARM 2023-10-01-preview. Firebase permissions are checked by Azure/FCM.", null);
			}
			if (provider is not ("apns-certificate" or "mpns-certificate"))
				throw Invalid();
			var prefix = bytes.AsSpan().StartsWith(new byte[] { 0xef, 0xbb, 0xbf }) ? 3 : 0;
			while (prefix < bytes.Length && bytes[prefix] is 9 or 10 or 13 or 32)
				prefix++;
			if (bytes.AsSpan(prefix).StartsWith("-----BEGIN"u8))
			{
				var normalized = CertificatePem(new UTF8Encoding(false, true).GetString(bytes).TrimStart('\ufeff').Trim(), password);
				try
				{
					return Import(provider, normalized, password);
				}
				finally { CryptographicOperations.ZeroMemory(normalized); }
			}
			var info = Pkcs12Info.Decode(bytes, out var consumed);
			if (consumed != bytes.Length || info.IntegrityMode != Pkcs12IntegrityMode.Password || !info.VerifyMac(password) || info.AuthenticatedSafe.Count > 8)
				throw Invalid();
			List<X509Certificate2> certificates = [];
			List<AsymmetricAlgorithm> keys = [];
			try
			{
				foreach (var safe in info.AuthenticatedSafe)
				{
					if (safe.ConfidentialityMode == Pkcs12ConfidentialityMode.Password)
						safe.Decrypt(password);
					if (safe.ConfidentialityMode != Pkcs12ConfidentialityMode.None)
						throw Invalid();
					foreach (var bag in safe.GetBags())
					{
						if (certificates.Count + keys.Count >= 32)
							throw Invalid();
						if (bag is Pkcs12CertBag certBag)
						{
							if (!certBag.IsX509Certificate)
								throw Invalid();
							certificates.Add(certBag.GetCertificate());
						}
						else if (bag is Pkcs12KeyBag or Pkcs12ShroudedKeyBag)
						{
							AsymmetricAlgorithm? key = null;
							foreach (var candidate in new AsymmetricAlgorithm[] { RSA.Create(), ECDsa.Create() })
							{
								if (key is not null)
								{
									candidate.Dispose();
									continue;
								}
								try
								{
									if (bag is Pkcs12ShroudedKeyBag encrypted)
										candidate.ImportEncryptedPkcs8PrivateKey(password, encrypted.EncryptedPkcs8PrivateKey.Span, out _);
									else
										candidate.ImportPkcs8PrivateKey(((Pkcs12KeyBag)bag).Pkcs8PrivateKey.Span, out _);
									key = candidate;
								}
								catch (CryptographicException) { candidate.Dispose(); }
							}
							if (key is null)
								throw Invalid();
							keys.Add(key);
						}
						else
							throw Invalid();
					}
				}
				if (keys.Count != 1)
					throw Invalid();
				var privateKey = keys[0];
				if (privateKey is RSA && privateKey.KeySize < 2048 || privateKey is ECDsa && privateKey.KeySize < 256)
					throw Invalid();
				var publicKey = privateKey.ExportSubjectPublicKeyInfo();
				var matching = certificates.Where(c => c.PublicKey.ExportSubjectPublicKeyInfo().AsSpan().SequenceEqual(publicKey)).ToArray();
				if (matching.Length != 1)
					throw Invalid();
				var cert = matching[0];
				var now = DateTimeOffset.UtcNow;
				var until = new DateTimeOffset(cert.NotAfter.ToUniversalTime());
				if (new DateTimeOffset(cert.NotBefore.ToUniversalTime()) > now || until <= now || cert.Extensions.OfType<X509BasicConstraintsExtension>().Any(e => e.CertificateAuthority))
					throw Invalid();
				var contents = new Pkcs12SafeContents();
				contents.AddCertificate(cert);
				contents.AddShroudedKey(privateKey, password, new PbeParameters(PbeEncryptionAlgorithm.Aes256Cbc, HashAlgorithmName.SHA256, 10000));
				var builder = new Pkcs12Builder();
				builder.AddSafeContentsUnencrypted(contents);
				builder.SealWithMac(password, HashAlgorithmName.SHA256, 10000);
				var normalized = builder.Encode();
				try
				{
					return (new()
					{
						[provider == "apns-certificate" ? "apnsCertificate" : "mpnsCertificate"] = Convert.ToBase64String(normalized),
						["certificateKey"] = password,
						["thumbprint"] = cert.Thumbprint
					}, $"Certificate with matching private key validated locally. Expires {until:yyyy-MM-dd HH:mm} UTC. Provider trust and application entitlement still require Azure/PNS validation.", until);
				}
				finally { CryptographicOperations.ZeroMemory(normalized); }
			}
			finally { foreach (var cert in certificates) cert.Dispose(); foreach (var key in keys) key.Dispose(); }
		}
		catch (Exception e) when (e is CryptographicException or JsonException or InvalidOperationException or ArgumentException or KeyNotFoundException or DecoderFallbackException or NullReferenceException) { throw Invalid(); }
	}
}
