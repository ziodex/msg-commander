using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MsgCommander.Host;
static class NotificationHubCredentialChecks
{
	static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	static string Id() => Guid.NewGuid().ToString();
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	private sealed class Factory(NotificationHubWire wire) : INotificationHubGatewayFactory
	{
		public async Task<INotificationHubGateway> ConnectAsync(ConnectionProfile profile, NotificationHubManagement management, Func<DeviceCodeEvent, Task> code, CancellationToken cancellation) => await FixtureNotificationHubFactory.Connect(wire, cancellation);
	}
	public static async Task<int> Run()
	{
		var wire = new NotificationHubWire();
		await using var workspace = new NotificationHubWorkspace(new Factory(wire));
		Task<object?> Call(string method, object request, CancellationToken cancellation = default) => workspace.ExecuteAsync(method, JsonSerializer.SerializeToElement(request, Json), _ => Task.CompletedTask, cancellation);
		var profile = new
		{
			id = Id(),
			name = "Fixture",
			service = "notification-hubs",
			@namespace = "fixture.servicebus.windows.net",
			auth = "device-code",
			tenantId = "fixture",
			clientId = Id(),
			rememberSecret = false
		};
		async Task<NotificationHubConnection> Connect() => (NotificationHubConnection)(await Call("nh.connect", new
		{
			operationId = Id(),
			profile,
			management = new NotificationHubManagement(FixtureNotificationHubFactory.Root, "fixture", Id())
		}))!;
		var connection = await Connect();
		var target = new NotificationHubTarget(new("hub", "alerts"), null);
		async Task<NotificationHubCredentialStatus> Status(string provider, NotificationHubTarget? selected = null) => (NotificationHubCredentialStatus)(await Call("nh.credentials.get", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			target = selected ?? target,
			provider
		}))!;
		async Task<NotificationHubCredentialArtifact> Import(string provider, byte[] bytes, string password = "", NotificationHubTarget? selected = null) => (NotificationHubCredentialArtifact)(await Call("nh.credentials.import", new NotificationHubCredentialImport(Id(), connection.ConnectionId, selected ?? target, provider, password, Convert.ToBase64String(bytes))))!;
		async Task<NotificationHubOutcome> Change(object draft, string? revision = null, string? operation = null, CancellationToken cancellation = default, NotificationHubTarget? selected = null)
		{
			var provider = JsonSerializer.SerializeToElement(draft, Json).GetProperty("provider").GetString()!;
			revision ??= (await Status(provider, selected)).Revision;
			return (NotificationHubOutcome)(await Call("nh.credentials.change", new
			{
				id = operation ?? Id(),
				connectionId = connection.ConnectionId,
				target = selected ?? target,
				expectedRevision = revision,
				draft,
				acknowledged = true
			}, cancellation))!;
		}
		using var ec = ECDsa.Create(ECCurve.NamedCurves.nistP256);
		var pem = Encoding.UTF8.GetBytes(ec.ExportPkcs8PrivateKeyPem());
		var apple = await Import("apns-token", pem);
		Assert(!JsonSerializer.Serialize(apple).Contains(Convert.ToBase64String(ec.ExportPkcs8PrivateKey())) && apple.Provider == "apns-token", "Imports expose only opaque handles and safe metadata");
		var draft = new
		{
			provider = "apns-token",
			artifactId = apple.ArtifactId,
			environment = "sandbox",
			keyId = "ABCDEFGHIJ",
			teamId = "0123456789",
			bundleId = "com.example.app"
		};
		var revision = (await Status("apns-token")).Revision;
		var operation = Id();
		var saved = await Change(draft, revision, operation);
		Assert(saved.Status == "confirmed", "APNS key applied");
		var body = JsonNode.Parse(wire.Requests.Last(r => r.Method == "PATCH").Body!)!;
		var props = body["properties"]!.AsObject();
		var apns = props["apnsCredential"]!["properties"]!;
		Assert(body.AsObject().Count == 1 && props.Count == 1 && apns["appId"]!.GetValue<string>() == "0123456789" && apns["appName"]!.GetValue<string>() == "com.example.app" && apns["endpoint"]!.GetValue<string>() == "https://api.development.push.apple.com:443/3/device", "Exact scoped APNS properties and endpoint");
		Assert(apns["apnsCertificate"] is null && apns["certificateKey"] is null && apns["token"]!.GetValue<string>() == Convert.ToBase64String(ec.ExportPkcs8PrivateKey()), "PKCS8 token with incompatible certificate fields cleared");
		Assert(wire.Data(target.Suffix())["properties"]!["gcmCredential"]!["properties"]!["googleApiKey"]!.GetValue<string>() == "SECRET-PNS" && wire.Data(target.Suffix())["tags"]!["environment"]!.GetValue<string>() == "fixture" && wire.Data(target.Suffix())["properties"]!["futureSetting"]!.GetValue<string>() == "preserved", "Other provider credentials, tags and future settings preserved");
		var count = wire.Requests.Count;
		Assert(await Change(draft, revision, operation) == saved && count == wire.Requests.Count, "Same request returns immutable receipt without read or retry");
		try
		{
			await Change(draft with
			{
				bundleId = "different.app"
			}, revision, operation);
			throw new Exception("Altered ID reuse accepted");
		}
		catch (OperationException) { }
		Assert((await Change(draft, revision)).Status == "failed", "Stale hub revision rejected");
		Assert(!JsonSerializer.Serialize(await Status("apns-token")).Contains("ABCDEFGHIJ"), "Reads never expose credential values");
		using var rsa = RSA.Create(2048);
		var firebase = JsonSerializer.SerializeToUtf8Bytes(new
		{
			type = "service_account",
			project_id = "fixture-project",
			client_email = "sender@fixture-project.iam.gserviceaccount.com",
			private_key = rsa.ExportPkcs8PrivateKeyPem(),
			token_uri = "https://evil.invalid/ignored"
		});
		var fcm = await Import("fcm-v1", firebase);
		var fcmDraft = new
		{
			provider = "fcm-v1",
			artifactId = fcm.ArtifactId
		};
		Assert((await Change(fcmDraft)).Status == "confirmed", "FCM v1 service-account import and update");
		var last = wire.Requests.Last(r => r.Method == "PATCH");
		var fcmProperties = JsonNode.Parse(last.Body!)!["properties"]!["fcmV1Credential"]!["properties"]!.AsObject();
		Assert(last.Path.EndsWith("api-version=2023-10-01-preview") && fcmProperties.Count == 3 && fcmProperties["projectId"]!.GetValue<string>() == "fixture-project" && fcmProperties["privateKey"]!.GetValue<string>().Contains("BEGIN PRIVATE KEY"), "FCM preview API and allowlisted service-account fields");
		Assert(!last.Body!.Contains("evil.invalid"), "Imported credential metadata cannot supply request endpoints");
		foreach (var (provider, d) in new (string, object)[] { ("wns", new { provider = "wns", packageSid = "SECRET-SID", secretKey = "SECRET-WNS" }), ("adm", new { provider = "adm", clientId = "SECRET-ID", clientSecret = "SECRET-ADM" }), ("baidu", new { provider = "baidu", apiKey = "SECRET-API", secretKey = "SECRET-BAIDU" }) })
		{
			Assert((await Change(d)).Status == "confirmed" && (await Status(provider)).Configured, "Provider configured");
			var request = wire.Requests.Last(r => r.Method == "PATCH");
			Assert(request.Path.EndsWith("api-version=2023-09-01") && JsonNode.Parse(request.Body!)!["properties"]!.AsObject().Count == 1, "Stable API and provider-only PATCH");
			if (provider == "baidu")
				Assert(JsonNode.Parse(request.Body!)!["properties"]!["baiduCredential"]!["properties"]!["baiduEndPoint"]!.GetValue<string>() == "https://channel.api.duapp.com/rest/2.0/channel/channel", "Baidu field casing and endpoint");
		}
		byte[] Certificate(DateTimeOffset start, DateTimeOffset end, bool privateKey = true)
		{
			var request = new CertificateRequest("CN=Offline fixture", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
			using var cert = request.CreateSelfSigned(start, end);
			if (privateKey)
				return cert.Export(X509ContentType.Pkcs12, "SECRET-PASSWORD");
			using var publicOnly = X509CertificateLoader.LoadCertificate(cert.Export(X509ContentType.Cert));
			return publicOnly.Export(X509ContentType.Pkcs12, "SECRET-PASSWORD");
		}
		var validCert = Certificate(DateTimeOffset.UtcNow.AddHours(-1), DateTimeOffset.UtcNow.AddDays(7));
		foreach (var provider in new[] { "apns-certificate", "mpns-certificate" })
		{
			var artifact = await Import(provider, validCert, "SECRET-PASSWORD");
			var result = provider == "apns-certificate" ? await Change(new
			{
				provider,
				artifactId = artifact.ArtifactId,
				environment = "production"
			}) : await Change(new
			{
				provider,
				artifactId = artifact.ArtifactId
			});
			Assert(result.Status == "confirmed" && artifact.Summary.Contains("Expires") && !artifact.Summary.Contains("SECRET"), "Certificate validated, metadata bounded and certificate applied");
			var configured = JsonNode.Parse(wire.Requests.Last(r => r.Method == "PATCH").Body!)!["properties"]![NotificationHubCredentials.Property(provider)]!["properties"]!;
			var normalized = Convert.FromBase64String(configured[provider == "apns-certificate" ? "apnsCertificate" : "mpnsCertificate"]!.GetValue<string>());
			var roundtrip = new AzureProviderCredentialCodec().Import(provider, normalized, "SECRET-PASSWORD");
			Assert(roundtrip.Material.Provider == provider && configured["thumbprint"] is not null, "Normalized certificate retains matching private key without keychain import");
			if (provider == "apns-certificate")
				Assert(configured["token"] is null && configured["keyId"] is null && configured["endpoint"]!.GetValue<string>() == "gateway.push.apple.com", "Certificate switch clears token mode");
		}
		string Encode(byte[] v) => Convert.ToBase64String(v).TrimEnd('=').Replace('+', '-').Replace('/', '_');
		var vapid = ec.ExportParameters(true);
		var publicKey = Encode(new byte[] { 4 }.Concat(vapid.Q.X!).Concat(vapid.Q.Y!).ToArray());
		var privateKey = Encode(vapid.D!);
		var browser = new
		{
			provider = "browser",
			subject = "mailto:push@example.com",
			vapidPublicKey = publicKey,
			vapidPrivateKey = privateKey
		};
		Assert((await Change(browser)).Status == "confirmed" && (await Status("browser")).Configured, "Matching VAPID keys configured using stable ARM");
		var browserBody = JsonNode.Parse(wire.Requests.Last(r => r.Method == "PATCH").Body!)!["properties"]!.AsObject();
		Assert(browserBody.Count == 1 && browserBody["browserCredential"]!["properties"]!["vapidPublicKey"]!.GetValue<string>() == publicKey, "Browser provider-only shape");
		using var other = ECDsa.Create(ECCurve.NamedCurves.nistP256);
		var browserWrites = wire.Requests.Count(r => r.Method == "PATCH");
		Assert((await Change(browser with
		{
			vapidPrivateKey = Encode(other.ExportParameters(true).D!)
		})).Status == "failed" && wire.Requests.Count(r => r.Method == "PATCH") == browserWrites, "Mismatched VAPID key pair rejected without dispatch");
		Assert((await Change(browser with
		{
			subject = "http://example.com"
		})).Status == "failed", "Unsafe VAPID contact rejected");
		Assert((await Change(browser with
		{
			vapidPrivateKey = privateKey[..^1] + "B"
		})).Status == "failed", "Noncanonical VAPID key rejected");
		var xiaomi = new
		{
			provider = "xiaomi",
			appSecret = "SECRET-XIAOMI",
			endpoint = "https://api-eu.xmpush.xiaomi.com/v3/message/regid"
		};
		Assert((await Change(xiaomi)).Status == "confirmed", "Xiaomi ARM configuration");
		Assert(JsonNode.Parse(wire.Requests.Last(r => r.Method == "PATCH").Body!)!["properties"]!["xiaomiCredential"]!["properties"]!["appSecret"]!.GetValue<string>() == "SECRET-XIAOMI", "Exact Xiaomi field names");
		foreach (var endpoint in new[] { "https://evil.invalid/v3/message/regid", "http://api.xmpush.xiaomi.com/v3/message/regid", "https://api.xmpush.xiaomi.com/v3/message/regid?secret=x" })
			Assert((await Change(xiaomi with
			{
				endpoint = endpoint
			})).Status == "failed", "Xiaomi endpoint validated without desktop calls");
		using (var generated = new CertificateRequest("CN=PEM fixture", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1).CreateSelfSigned(DateTimeOffset.UtcNow.AddHours(-1), DateTimeOffset.UtcNow.AddDays(2)))
		using (var cert = X509CertificateLoader.LoadCertificate(generated.Export(X509ContentType.Cert)))
		{
			foreach (var keyPem in new[] { rsa.ExportPkcs8PrivateKeyPem(), rsa.ExportRSAPrivateKeyPem(), rsa.ExportEncryptedPkcs8PrivateKeyPem("SECRET-PASSWORD", new PbeParameters(PbeEncryptionAlgorithm.Aes256Cbc, HashAlgorithmName.SHA256, 10000)) })
			{
				var bundle = Encoding.UTF8.GetBytes(cert.ExportCertificatePem() + "\n" + keyPem);
				var imported = await Import("apns-certificate", bundle, "SECRET-PASSWORD");
				Assert((await Change(new
				{
					provider = "apns-certificate",
					artifactId = imported.ArtifactId,
					environment = "sandbox"
				})).Status == "confirmed", "PEM key/certificate normalized through managed PKCS12 validation");
			}
			foreach (var bundle in new[] { cert.ExportCertificatePem(), cert.ExportCertificatePem() + "\n" + other.ExportPkcs8PrivateKeyPem(), cert.ExportCertificatePem() + "\n" + rsa.ExportPkcs8PrivateKeyPem() + "\n" + rsa.ExportPkcs8PrivateKeyPem(), cert.ExportCertificatePem() + "\nUNPARSED TEXT\n" + rsa.ExportPkcs8PrivateKeyPem(), cert.ExportCertificatePem() + "\n" + rsa.ExportEncryptedPkcs8PrivateKeyPem("OTHER-PASSWORD", new PbeParameters(PbeEncryptionAlgorithm.Aes256Cbc, HashAlgorithmName.SHA256, 10000)) })
			{
				try
				{
					await Import("apns-certificate", Encoding.UTF8.GetBytes(bundle), "SECRET-PASSWORD");
					throw new Exception("Invalid PEM accepted");
				}
				catch (OperationException e) { Assert(!e.Message.Contains("SECRET"), "PEM errors sanitized"); }
			}
		}
		var removeRevision = (await Status("apns-token")).Revision;
		using (var ecCert = new CertificateRequest("CN=EC PEM fixture", ec, HashAlgorithmName.SHA256).CreateSelfSigned(DateTimeOffset.UtcNow.AddHours(-1), DateTimeOffset.UtcNow.AddDays(2)))
		{
			foreach (var keyPem in new[] { ec.ExportPkcs8PrivateKeyPem(), ec.ExportECPrivateKeyPem() })
			{
				var bundle = Encoding.UTF8.GetBytes("\ufeff \t\n" + ecCert.ExportCertificatePem() + "\n" + keyPem);
				Assert((await Import("mpns-certificate", bundle)).Summary.Contains("matching private key"), "EC PKCS8/SEC1 PEM with BOM and whitespace validates locally");
			}
		}
		var removed = await Change(new
		{
			provider = "apns-certificate",
			remove = true
		}, removeRevision);
		Assert(removed.Status == "confirmed" && !(await Status("apns-token")).Configured && (await Status("browser")).Configured, "Removal clears shared APNS slot and preserves other providers");
		var removal = JsonNode.Parse(wire.Requests.Last(r => r.Method == "PATCH").Body!)!["properties"]!.AsObject();
		Assert(removal.Count == 1 && removal.ContainsKey("apnsCredential") && removal["apnsCredential"] is null, "Removal emits explicit null for exactly one provider");
		Assert((await Change(new
		{
			provider = "browser",
			remove = true
		}, removeRevision)).Status == "failed", "Stale removal rejected");
		Assert((await Change(new
		{
			provider = "browser",
			remove = true,
			subject = "extra"
		})).Status == "failed", "Removal cannot carry replacement fields");
		Assert((await Change(new
		{
			provider = "gcm-legacy",
			apiKey = "SECRET"
		})).Status == "failed", "Retired credential replacements blocked");
		Assert((await Change(new
		{
			provider = "gcm-legacy",
			remove = true
		})).Status == "confirmed" && !(await Status("gcm-legacy")).Configured && (await Status("fcm-v1")).Configured, "Retired GCM cleanup preserves FCM v1 credentials");
		var wrongCurve = ECDsa.Create(ECCurve.NamedCurves.nistP384);
		using (wrongCurve)
		{
			foreach (var (provider, bytes, password) in new (string, byte[], string)[] { ("apns-token", Encoding.UTF8.GetBytes(wrongCurve.ExportPkcs8PrivateKeyPem()), ""), ("apns-token", Encoding.UTF8.GetBytes(ec.ExportSubjectPublicKeyInfoPem()), ""), ("apns-token", pem.Concat(pem).ToArray(), ""), ("fcm-v1", Encoding.UTF8.GetBytes("{\"type\":\"service_account\",\"type\":\"service_account\"}"), ""), ("apns-certificate", validCert, "bad"), ("apns-certificate", Certificate(DateTimeOffset.UtcNow.AddDays(-2), DateTimeOffset.UtcNow.AddDays(-1)), "SECRET-PASSWORD"), ("apns-certificate", Certificate(DateTimeOffset.UtcNow.AddDays(1), DateTimeOffset.UtcNow.AddDays(2)), "SECRET-PASSWORD"), ("apns-certificate", Certificate(DateTimeOffset.UtcNow.AddHours(-1), DateTimeOffset.UtcNow.AddDays(1), false), "SECRET-PASSWORD"), ("apns-token", new byte[262145], "") })
			{
				var writes = wire.Requests.Count(r => r.Method == "PATCH");
				try
				{
					await Import(provider, bytes, password);
					throw new Exception("Invalid credential accepted");
				}
				catch (OperationException e) { Assert(!e.Message.Contains("SECRET"), "Sanitized credential errors"); }
				Assert(wire.Requests.Count(r => r.Method == "PATCH") == writes, "Invalid import makes no Azure writes");
			}
		}
		var foreign = new NotificationHubTarget(new("hub", "archive"), null);
		Assert((await Change(draft, selected: foreign)).Status == "failed", "Imported key cannot cross hub scope");
		await Call("nh.credentials.discard", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			target,
			artifactId = apple.ArtifactId
		});
		Assert((await Change(draft)).Status == "failed", "Discarded imports cannot be used");
		var wns = new
		{
			provider = "wns",
			packageSid = "SECRET-SID",
			secretKey = "SECRET-WNS"
		};
		using (var cancel = new CancellationTokenSource())
		{
			var before = (await Status("wns")).Revision;
			wire.BeforeRequest = (method, path) => { if (method == "GET") cancel.Cancel(); };
			Assert((await Change(wns, before, cancellation: cancel.Token)).Status == "cancelled", "Cancellation before dispatch has a truthful receipt");
			wire.BeforeRequest = null;
		}
		foreach (var (name, expected) in new[] { ("unknown-provider", "unknown"), ("rejected-provider", "failed") })
		{
			wire.Seed("notificationHubs", name, new()
			{
				["registrationTtl"] = "1.00:00:00"
			});
			var scoped = new NotificationHubTarget(new("hub", name), null);
			var value = await Change(wns, selected: scoped);
			Assert(value.Status == expected && !JsonSerializer.Serialize(value).Contains("SECRET"), "Uncertain and rejected writes retain sanitized outcomes");
			Assert(wire.Requests.Count(r => r.Method == "PATCH" && r.Path.Contains(name)) == 1, "No automatic retry on rejection/lost response");
		}
		wire.MalformedPatchReply = true;
		Assert((await Change(wns)).Status == "confirmed", "Acknowledged provider update remains confirmed when response details are malformed");
		wire.MalformedPatchReply = false;
		var receipt = (NotificationHubOutcome)(await Call("nh.result", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			operationId = saved.OperationId
		}))!;
		Assert(receipt == saved, "Admin receipt recovery works for provider writes");
		connection = await Connect();
		Assert((await Change(fcmDraft)).Status == "failed", "Reconnect clears private imports");
		for (var n = 0; n < 20; n++)
			await Import("apns-token", pem);
		try
		{
			await Import("apns-token", pem);
			throw new Exception("Private import cap bypassed");
		}
		catch (OperationException e) { Assert(e.Message.Contains("limit"), "Private import cache is bounded"); }
		Console.WriteLine("Notification Hubs provider credential checks passed");
		return 0;
	}
}
