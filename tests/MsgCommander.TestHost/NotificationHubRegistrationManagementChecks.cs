using System.Net;
using System.Text.Json;
using System.Xml.Linq;
using MsgCommander.Host;
static class NotificationHubRegistrationManagementChecks
{
	static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	static string Id() => Guid.NewGuid().ToString();
	static readonly XNamespace S = "http://schemas.microsoft.com/netservices/2010/10/servicebus/connect";
	private sealed class Factory(NotificationHubRegistrationsWire wire) : INotificationHubRegistrationsGatewayFactory
	{
		public INotificationHubRegistrationsGateway Create(ConnectionProfile profile, string hubName) => new AzureNotificationHubRegistrationsGateway(profile, hubName, wire);
	}
	public static async Task<int> Run()
	{
		var wire = new NotificationHubRegistrationsWire();
		await using var admin = new NotificationHubWorkspace(new FixtureNotificationHubFactory());
		await using var workspace = new NotificationHubRegistrationsWorkspace(new Factory(wire), admin);
		var profile = NotificationHubRegistrationsAdapterChecks.Profile();
		var setup = new NotificationHubRegistrationsConnect(Id(), profile.Id, "alerts", "profile", null, null, null);
		var connection = (NotificationHubRegistrationsConnection)(await workspace.ExecuteAsync("nh.registrations.connect", JsonSerializer.SerializeToElement(new
		{
			request = setup,
			profile
		}, Json), default))!;
		Task<object?> Call(string method, object request, CancellationToken cancellation = default) => workspace.ExecuteAsync(method, JsonSerializer.SerializeToElement(request, Json), cancellation);
		async Task<NotificationHubRegistrationOutcome> Change(string action, NotificationHubRegistrationDetails? original, NotificationHubRegistrationDraft? draft, string? id = null, CancellationToken cancellation = default) => (NotificationHubRegistrationOutcome)(await Call("nh.registrations.change", new NotificationHubRegistrationChange(id ?? Id(), connection.ConnectionId, action, original?.Registration.SnapshotId, draft, true), cancellation))!;
		async Task<NotificationHubRegistrationDetails> Get(string snapshot) => (NotificationHubRegistrationDetails)(await Call("nh.registrations.get", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			snapshotId = snapshot
		}))!;
		var page = (NotificationHubRegistrationsPage)(await Call("nh.registrations.query", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			query = new NotificationHubRegistrationQuery("all", "", "any", 25),
			continuationToken = (string?)null
		}))!;
		var apple = await Get(page.Items[0].SnapshotId);
		var template = await Get(page.Items[1].SnapshotId);
		Assert(apple.Etag == "W/\"42\"" && wire.Requests.Last().Uri.AbsolutePath.EndsWith("/fcm-template"), "Fresh read and HTTP ETag");
		var root = XElement.Parse(template.RawXml);
		root.Element(S + "BodyTemplate")!.Value = "{\"message\":{\"notification\":{\"title\":\"$(subject)\"}}}";
		var draft = new NotificationHubRegistrationDraft(root.ToString(), ["updated", "customer:123"]);
		var operation = Id();
		var updated = await Change("update", template, draft, operation);
		Assert(updated.Status == "confirmed" && updated.RegistrationId == "fcm-template" && updated.Etag == "W/\"43\"", "PUT receipt captures server ID/ETag");
		Assert(wire.Writes.Last().Method == "PUT" && wire.Writes.Last().IfMatch == "W/\"42\"", "PUT exact weak If-Match");
		var payload = XDocument.Parse(wire.Writes.Last().Body!);
		Assert(payload.Descendants(S + "FutureProperty").Single().Value == "<script>data only</script>" && !payload.Descendants(S + "RegistrationId").Any() && !payload.Descendants(S + "ExpirationTime").Any(), "Unknown XML preserved; read-only metadata omitted");
		var writes = wire.Writes.Count;
		Assert(await Change("update", template, draft, operation) == updated && wire.Writes.Count == writes, "Same operation returns receipt without dispatch");
		try
		{
			await Change("delete", template, null, operation);
			throw new Exception("Reused ID accepted");
		}
		catch (OperationException) { }
		var fresh = await Get(updated.SnapshotId!);
		Assert(fresh.TemplateBody!.Contains("$(subject)") && fresh.Registration.Tags.SequenceEqual(draft.Tags), "Template and tags persisted");
		wire.Bump("fcm-template");
		var conflict = await Change("delete", fresh, null);
		Assert(conflict.Status == "failed" && conflict.Summary.Contains("ETag conflict") && !conflict.Summary.Contains("SECRET"), "412 is a rejected stale write");
		fresh = await Get(fresh.Registration.SnapshotId);
		var deleted = await Change("delete", fresh, null);
		Assert(deleted.Status == "confirmed" && wire.Writes.Last().Method == "DELETE" && wire.Writes.Last().IfMatch == fresh.Etag, "Delete reloads and sends exact If-Match");
		try
		{
			await Get(fresh.Registration.SnapshotId);
			throw new Exception("Deleted read succeeded");
		}
		catch (OperationException e) { Assert(e.Message.Contains("no longer exists"), "Missing remains missing"); }
		foreach (var platform in new[] { "Apple", "FcmV1", "Windows", "Mpns", "Adm", "Baidu", "Gcm", "Fcm", "Browser" })
			foreach (var isTemplate in new[] { false, true })
			{
				var field = platform switch
				{
					"Apple" => "DeviceToken",
					"Windows" or "Mpns" => "ChannelUri",
					"Baidu" => "BaiduUserId",
					"Browser" => "Endpoint",
					_ => platform + "RegistrationId"
				};
				var handle = platform == "Apple" ? NotificationHubRegistrationsWire.AppleToken : platform is "Windows" or "Mpns" or "Browser" ? "https://push.example.invalid/channel" : "token-value";
				var definition = new XElement(S + (platform + (isTemplate ? "Template" : "") + "RegistrationDescription"), new XElement(S + field, handle));
				definition.Add(new XElement(S + "PushVariables", "{\"locale\":\"en\"}"));
				if (platform == "Windows")
					definition.Add(new XElement(S + "SecondaryTileName", "tile-one"));
				if (platform == "Baidu")
					definition.Add(new XElement(S + "BaiduChannelId", "1234"));
				if (platform == "Browser")
				{
					using var key = System.Security.Cryptography.ECDsa.Create(System.Security.Cryptography.ECCurve.NamedCurves.nistP256);
					var q = key.ExportParameters(false).Q;
					string Encode(byte[] v) => Convert.ToBase64String(v).TrimEnd('=').Replace('+', '-').Replace('/', '_');
					definition.Add(new XElement(S + "P256DH", Encode(new byte[] { 4 }.Concat(q.X!).Concat(q.Y!).ToArray())), new XElement(S + "Auth", Encode(new byte[16])));
				}
				if (isTemplate)
				{
					definition.Add(new XElement(S + "BodyTemplate", new XCData(platform == "FcmV1" ? "{\"message\":{\"data\":{\"body\":\"$(message)\"}}}" : "{\"message\":\"$(message)\"}")), new XElement(S + "TemplateName", "sample"));
					if (platform is "Windows" or "Mpns")
					{
						var name = platform == "Windows" ? "Wns" : "Mpns";
						definition.Add(new XElement(S + name + "Headers", new XElement(S + name + "Header", new XElement(S + "Header", platform == "Windows" ? "X-WNS-Type" : "X-WindowsPhone-Target"), new XElement(S + "Value", "toast"))));
					}
				}
				var result = await Change("create", null, new(definition.ToString(), ["matrix"]));
				Assert(result.Status == "confirmed" && result.RegistrationId!.StartsWith("created-") && wire.Writes.Last().IfMatch is null && wire.Writes.Last().Method == "POST", "Supported native/template create");
				var sentRoot = XDocument.Parse(wire.Writes.Last().Body!).Descendants(S + definition.Name.LocalName).Single();
				Assert(sentRoot.Elements().Take(3).Select(e => e.Name.LocalName).SequenceEqual(new[] { "Tags", "PushVariables", field }), "Base and platform field order preserves PushVariables");
				var created = await Get(result.SnapshotId!);
				Assert(created.Registration.Kind == definition.Name.LocalName && created.Registration.Tags.Single() == "matrix", "Created platform readback");
				if (isTemplate)
				{
					var sent = XDocument.Parse(wire.Writes.Last().Body!).Descendants(S + "BodyTemplate").Single();
					Assert(sent.FirstNode is XCData, "Template CDATA serializer");
				}
			}
		foreach (var invalid in new[] { new NotificationHubRegistrationDraft("<!DOCTYPE x [<!ENTITY evil SYSTEM 'file:///etc/passwd'>]><AppleRegistrationDescription xmlns='" + S + "'>&evil;</AppleRegistrationDescription>", []), new(apple.RawXml, ["bad tag"]), new(apple.RawXml, Enumerable.Repeat("same", 2).ToArray()), new(apple.RawXml, Enumerable.Range(0, 61).Select(i => "tag" + i).ToArray()), new(apple.RawXml.Replace("apple-native", "other"), []), new(apple.RawXml.Replace("AppleRegistrationDescription", "FcmRegistrationDescription"), []) })
		{
			writes = wire.Writes.Count;
			var failed = await Change("update", apple, invalid);
			Assert(failed.Status == "failed" && wire.Writes.Count == writes, "Invalid XML/tags/identity rejected before dispatch");
		}
		wire.MissingEtag = true;
		var missing = await Get(apple.Registration.SnapshotId);
		wire.MissingEtag = false;
		writes = wire.Writes.Count;
		foreach (var definition in new[] { new XElement(S + "BrowserRegistrationDescription", new XElement(S + "Endpoint", "http://push.example.invalid/"), new XElement(S + "P256DH", "bad"), new XElement(S + "Auth", "bad")), new XElement(S + "FcmV1TemplateRegistrationDescription", new XElement(S + "FcmV1RegistrationId", "token"), new XElement(S + "BodyTemplate", "{\"notification\":{\"body\":\"legacy\"}}")) })
		{
			var before = wire.Writes.Count;
			Assert((await Change("create", null, new(definition.ToString(), []))).Status == "failed" && wire.Writes.Count == before, "Invalid Browser subscription and unconverted FCM v1 template refused before dispatch");
		}
		Assert((await Change("delete", missing, null)).Status == "failed" && wire.Writes.Count == writes, "Missing ETag never falls back to wildcard");
		foreach (var status in new[] { HttpStatusCode.BadRequest, HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden, HttpStatusCode.NotFound, HttpStatusCode.Conflict, HttpStatusCode.PreconditionFailed, HttpStatusCode.TooManyRequests })
		{
			wire.WriteStatusOverride = status;
			var failed = await Change("delete", apple, null);
			Assert(failed.Status == "failed" && !failed.Summary.Contains("SECRET"), "4xx rejected and sanitized");
		}
		wire.WriteStatusOverride = HttpStatusCode.RequestTimeout;
		Assert((await Change("delete", apple, null)).Status == "unknown", "Service timeout does not prove rejection");
		wire.WriteStatusOverride = HttpStatusCode.ServiceUnavailable;
		Assert((await Change("delete", apple, null)).Status == "unknown", "5xx does not prove rejection");
		wire.WriteStatusOverride = null;
		wire.LoseNextWriteResponse = true;
		var lost = await Change("update", apple, new(apple.RawXml, ["ack-lost"]));
		Assert(lost.Status == "unknown", "Lost acknowledgment is unknown");
		var recovered = (NotificationHubRegistrationOutcome)(await Call("nh.registrations.result", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			operationId = lost.OperationId
		}))!;
		Assert(recovered == lost, "Retained unknown receipt recoverable");
		apple = await Get(apple.Registration.SnapshotId);
		Assert(apple.Registration.Tags.Single() == "ack-lost", "Lost response did not roll back accepted write");
		wire.SlowNextWrite = true;
		using (var cancel = new CancellationTokenSource(50))
		{
			var cancelled = await Change("delete", apple, null, cancellation: cancel.Token);
			Assert(cancelled.Status == "unknown", "Cancellation after dispatch is uncertain");
		}
		wire.MalformedNextAck = true;
		var malformed = await Change("update", apple, new(apple.RawXml, ["malformed-ack"]));
		Assert(malformed.Status == "unknown", "Malformed acknowledged reply never enables blind retry");
		apple = await Get(apple.Registration.SnapshotId);
		using (var late = new CancellationTokenSource())
		{
			wire.OnWriteAcknowledged = late.Cancel;
			var acknowledged = await Change("update", apple, new(apple.RawXml, ["late-cancel"]), cancellation: late.Token);
			Assert(acknowledged.Status == "confirmed" && late.IsCancellationRequested, "Received acknowledgment survives late cancellation");
			wire.OnWriteAcknowledged = null;
		}
		await Call("nh.registrations.reset", new
		{
		});
		try
		{
			await Get(apple.Registration.SnapshotId);
			throw new Exception("Reset snapshot accepted");
		}
		catch (OperationException) { }
		Console.WriteLine("Notification Hubs registration management checks passed");
		return 0;
	}
}
