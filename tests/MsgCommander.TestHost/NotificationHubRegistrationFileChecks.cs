using System.Net;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using MsgCommander.Host;

static class NotificationHubRegistrationFileChecks
{
	static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	static readonly XNamespace S = RegistrationXml.Service, A = RegistrationXml.Atom;
	static string Id() => Guid.NewGuid().ToString();
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}

	private sealed class Factory(NotificationHubRegistrationsWire wire) : INotificationHubRegistrationsGatewayFactory
	{
		public INotificationHubRegistrationsGateway Create(ConnectionProfile profile, string hubName) => new AzureNotificationHubRegistrationsGateway(profile, hubName, wire);
	}

	sealed class Clock : TimeProvider
	{
		public DateTimeOffset Now = DateTimeOffset.UtcNow;
		public override DateTimeOffset GetUtcNow() => Now;
	}

	public static async Task<int> Run()
	{
		var clock = new Clock();
		var wire = new NotificationHubRegistrationsWire();
		await using var admin = new NotificationHubWorkspace(new FixtureNotificationHubFactory());
		await using var workspace = new NotificationHubRegistrationsWorkspace(new Factory(wire), admin, clock);
		var profile = NotificationHubRegistrationsAdapterChecks.Profile();
		var setup = new NotificationHubRegistrationsConnect(Id(), profile.Id, "alerts", "profile", null, null, null);
		var connection = (NotificationHubRegistrationsConnection)(await workspace.ExecuteAsync("nh.registrations.connect", JsonSerializer.SerializeToElement(new
		{
			request = setup,
			profile
		}, Json), default))!;
		Task<object?> Call(string method, object value, CancellationToken token = default, Func<object, Task>? emit = null) => workspace.ExecuteAsync(method, JsonSerializer.SerializeToElement(value, Json), token, emit);
		async Task<RegistrationFilePreview> Preview(string text) => (RegistrationFilePreview)(await Call("nh.registrations.files.preview", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			contentBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(text))
		}))!;
		async Task<RegistrationFileResult> Apply(RegistrationFilePreview p, CancellationToken token = default, Func<object, Task>? emit = null) => (RegistrationFileResult)(await Call("nh.registrations.files.apply", new RegistrationFileApply(Id(), connection.ConnectionId, p.ImportId, p.Entries.Where(e => e.Action == "create").Select(e => e.Id).ToArray(), true), token, emit))!;
		var page = (NotificationHubRegistrationsPage)(await Call("nh.registrations.query", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			query = new NotificationHubRegistrationQuery("all", "", "any", 25),
			continuationToken = (string?)null
		}))!;
		var future = (NotificationHubRegistrationsPage)(await Call("nh.registrations.query", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			query = new NotificationHubRegistrationQuery("tag", "future", "any", 25),
			continuationToken = (string?)null
		}))!;
		var encoded = JsonSerializer.SerializeToElement(await Call("nh.registrations.files.export", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			snapshotIds = page.Items.Concat(future.Items).Select(e => e.SnapshotId).ToArray(),
			format = "json"
		}), Json);
		var archive = RegistrationFiles.Decode(encoded.GetProperty("contentBase64").GetString()!);
		var previous = JsonSerializer.SerializeToUtf8Bytes(archive with
		{
			Format = "service-bus-commander/notification-hub-registrations"
		}, Json);
		var restored = RegistrationFiles.Decode(Convert.ToBase64String(previous));
		Assert(restored.Format == RegistrationFiles.Format && restored.Registrations[1].RawXml == archive.Registrations[1].RawXml, "Previous product archives preserve raw registration descriptions");
		Assert(archive.Registrations.Count == 3 && archive.Registrations[1].RawXml.Contains("FutureProperty") && archive.Registrations[1].Etag is not null, "Export full cached descriptions and metadata");
		var p = await Preview(JsonSerializer.Serialize(archive, Json));
		Assert(p.Entries.Count == 3 && p.Entries[2].Action == "blocked" && wire.Writes.Count == 0, "Future platform inspectable but blocked; preview sends no writes");
		var inspected = JsonSerializer.SerializeToElement(await Call("nh.registrations.files.inspect", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			importId = p.ImportId,
			entryId = p.Entries[1].Id
		}), Json);
		var definition = XElement.Parse(inspected.GetProperty("rawXml").GetString()!);
		Assert(!definition.Elements().Any(e => new[] { "RegistrationId", "ExpirationTime", "ETag" }.Contains(e.Name.LocalName)) && definition.Element(S + "BodyTemplate")!.Value.Contains("$(message)") && definition.Element(S + "FutureProperty")!.Value == "<script>data only</script>", "Preview removes read-only fields and preserves templates/extensions as inert data");
		try
		{
			await Call("nh.registrations.files.apply", new RegistrationFileApply(Id(), connection.ConnectionId, p.ImportId, [p.Entries[2].Id], true));
			throw new Exception("Blocked definition selected");
		}
		catch (OperationException)
		{
		}

		var operation = new RegistrationFileApply(Id(), connection.ConnectionId, p.ImportId, [p.Entries[0].Id, p.Entries[1].Id], true);
		var progress = new List<JsonElement>();
		var receipt = (RegistrationFileResult)(await Call("nh.registrations.files.apply", operation, emit: value =>
		{
			progress.Add(JsonSerializer.SerializeToElement(value, Json));
			return Task.CompletedTask;
		}))!;
		Assert(receipt.Status == "completed" && receipt.Steps.Select(s => s.Receipt!.RegistrationId).SequenceEqual(new[] { "created-1", "created-2" }) && progress.Count == 2, "Sequential import, progress, and assigned IDs");
		Assert(wire.Writes.All(w => w.Method == "POST" && w.IfMatch is null) && !wire.Writes.Any(w => w.Body!.Contains("<RegistrationId>")), "Imports never update/delete or send source IDs");
		var count = wire.Writes.Count;
		Assert((RegistrationFileResult)(await Call("nh.registrations.files.apply", operation))! == receipt && wire.Writes.Count == count, "Identical operation returns immutable receipt, no replay");
		try
		{
			await Call("nh.registrations.files.apply", operation with
			{
				EntryIds = [p.Entries[0].Id]
			});
			throw new Exception("Altered operation accepted");
		}
		catch (OperationException)
		{
		}

		Assert((RegistrationFileResult)(await Call("nh.registrations.files.result", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			operationId = operation.Id
		}))! == receipt, "Aggregate recoverable");
		var xml = Encoding.UTF8.GetString(RegistrationFiles.Encode(archive, "xml"));
		var roundtrip = RegistrationFiles.Decode(Convert.ToBase64String(Encoding.UTF8.GetBytes(xml)));
		Assert(roundtrip.Registrations.Count == 3, "Atom feed roundtrip");
		var utf16 = Encoding.Unicode.GetPreamble().Concat(Encoding.Unicode.GetBytes(xml.Replace("encoding=\"utf-8\"", "encoding=\"utf-16\""))).ToArray();
		Assert(RegistrationFiles.Decode(Convert.ToBase64String(utf16)).Registrations.Count == 3, "UTF-16 XML BOM supported");
		var sdk = new XElement(S + "RegistrationDescription", new XAttribute(XNamespace.Xmlns + "i", "http://www.w3.org/2001/XMLSchema-instance"), new XAttribute(XName.Get("type", "http://www.w3.org/2001/XMLSchema-instance"), "FcmV1TemplateRegistrationDescription"), new XElement(S + "FcmV1RegistrationId", "sdk-token"), new XElement(S + "BodyTemplate", new XCData("{\"message\":{\"data\":{\"body\":\"$(message)\"}}}")));
		Assert((await Preview(sdk.ToString())).Entries.Single().Action == "create", "SDK xsi:type serialization normalized");
		var raw = new XElement(S + "FcmV1RegistrationDescription", new XElement(S + "FcmV1RegistrationId", "copy-token"), new XElement(S + "Tags", "copy:tag"));
		string Feed(params XElement[] definitions) => new XElement(A + "feed", definitions.Select(d => new XElement(A + "entry", new XElement(A + "content", d)))).ToString();
		p = await Preview(Feed(raw, new XElement(raw)));
		Assert(p.Entries[0].Action == "create" && p.Entries[1].Action == "blocked", "Exact file duplicate blocked");
		p = await Preview(Feed(raw, new XElement(S + "FcmV1RegistrationDescription", new XElement(S + "FcmV1RegistrationId", "second-token"))));
		using (var late = new CancellationTokenSource())
		{
			wire.OnWriteAcknowledged = late.Cancel;
			var partial = await Apply(p, late.Token);
			wire.OnWriteAcknowledged = null;
			Assert(partial.Status == "cancelled" && partial.Steps[0].Status == "confirmed" && partial.Steps[1].Status == "not-attempted", "Late cancellation retains accepted first write and stops next");
		}

		p = await Preview(Feed(raw, new XElement(S + "FcmV1RegistrationDescription", new XElement(S + "FcmV1RegistrationId", "second-token"))));
		var startCount = wire.Writes.Count;
		wire.OnWriteAcknowledged = () =>
		{
			if (wire.Writes.Count == startCount + 1)
				wire.LoseNextWriteResponse = true;
		};
		var uncertain = await Apply(p);
		wire.OnWriteAcknowledged = null;
		Assert(uncertain.Status == "unknown" && uncertain.Steps[0].Status == "confirmed" && uncertain.Steps[1].Status == "unknown" && uncertain.Steps[1].Receipt!.RegistrationId is null && wire.Writes.Count == startCount + 2 && !uncertain.Summary.Contains("SECRET"), "Lost second create ack retains partial truth without retry");
		p = await Preview(raw.ToString());
		wire.WriteStatusOverride = HttpStatusCode.Forbidden;
		Assert((await Apply(p)).Status == "failed", "Definite service rejection preserved");
		wire.WriteStatusOverride = null;
		p = await Preview(raw.ToString());
		count = wire.Writes.Count;
		var stopped = await Apply(p, emit: _ => throw new IOException("closed progress pipe"));
		Assert(stopped.Status == "cancelled" && wire.Writes.Count == count, "Closed progress transport prevents writes and retains receipt");
		var original = JsonSerializer.Serialize(archive, Json);
		foreach (var invalid in new[]
		{
			original.Replace("\"version\":1", "\"version\":2"),
			original.Replace("\"version\":1", "\"version\":1,\"version\":1"),
			original.Replace("\"version\":1", "\"version\":1,\"secret\":\"SECRET\""),
			"<!DOCTYPE x [<!ENTITY x SYSTEM 'file:///etc/passwd'>]>" + raw,
			Feed(new XElement(raw.Name, raw.Attributes(), raw.Elements(), new XElement(S + "Tags", "duplicate"))),
			new XElement(A + "feed", new XElement("entry", new XElement(A + "content", raw))).ToString(),
			new XElement(A + "entry", new XElement(A + "content", raw), new XElement(A + "content", raw)).ToString(),
			"<invalid>",
			new string ('x', 524289)
		}

		)
		{
			count = wire.Writes.Count;
			try
			{
				await Preview(invalid);
				throw new Exception("Invalid file accepted");
			}
			catch (OperationException e)
			{
				Assert(!e.Message.Contains("SECRET") && wire.Writes.Count == count, "Invalid file fails closed and sanitized");
			}
		}

		var repeatedId = archive with
		{
			Registrations = [archive.Registrations[0], archive.Registrations[0]]
		};
		try
		{
			RegistrationFiles.Encode(repeatedId, "json");
			throw new Exception("Duplicate identity accepted");
		}
		catch (OperationException)
		{
		}

		p = await Preview(raw.ToString());
		await Preview(raw.ToString());
		try
		{
			await Apply(p);
			throw new Exception("Superseded preview accepted");
		}
		catch (OperationException)
		{
		}

		p = await Preview(raw.ToString());
		clock.Now = clock.Now.AddMinutes(11);
		count = wire.Writes.Count;
		try
		{
			await Apply(p);
			throw new Exception("Expired preview accepted");
		}
		catch (OperationException)
		{
			Assert(wire.Writes.Count == count, "Expired plan never dispatches");
		}

		try
		{
			RegistrationFiles.Decode(Convert.ToBase64String(Encoding.UTF8.GetBytes(Feed(Enumerable.Range(0, 101).Select(i => new XElement(S + "FcmV1RegistrationDescription", new XElement(S + "FcmV1RegistrationId", "token-" + i))).ToArray()))));
			throw new Exception("Oversize count accepted");
		}
		catch (OperationException)
		{
		}

		try
		{
			RegistrationFiles.Decode(Convert.ToBase64String(Encoding.UTF8.GetBytes(raw.ToString().Replace("copy-token", new string('x', 131073)))));
			throw new Exception("Oversize definition accepted");
		}
		catch (OperationException)
		{
		}

		// Receipt capacity is checked before writes, so recovery remains bounded and complete.
		for (var i = 5; i < 20; i++)
		{
			p = await Preview(raw.ToString());
			await Apply(p);
		}

		p = await Preview(raw.ToString());
		count = wire.Writes.Count;
		try
		{
			await Apply(p);
			throw new Exception("Receipt cap ignored");
		}
		catch (OperationException e)
		{
			Assert(e.Message.Contains("receipt limit") && wire.Writes.Count == count, "Capacity refuses before writes");
		}

		await Call("nh.registrations.reset", new
		{
		});
		try
		{
			await Apply(p);
			throw new Exception("Reset preview accepted");
		}
		catch (OperationException)
		{
		}

		Console.WriteLine("Notification Hubs registration file checks passed");
		return 0;
	}
}
