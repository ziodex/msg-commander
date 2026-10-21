using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MsgCommander.Host;
static class NotificationHubConfigurationChecks
{
	private sealed class Clock : TimeProvider
	{
		public DateTimeOffset Now = DateTimeOffset.UtcNow; public override DateTimeOffset GetUtcNow() => Now;
	}
	private sealed class Factory(NotificationHubWire wire) : INotificationHubGatewayFactory
	{
		public async Task<INotificationHubGateway> ConnectAsync(ConnectionProfile p, NotificationHubManagement m, Func<DeviceCodeEvent, Task> code, CancellationToken cancellation) => await FixtureNotificationHubFactory.Connect(wire, cancellation);
	}
	private static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	public static async Task<int> Run()
	{
		var wire = new NotificationHubWire();
		var clock = new Clock();
		await using var workspace = new NotificationHubWorkspace(new Factory(wire), clock);
		JsonElement Input(object v) => JsonSerializer.SerializeToElement(v, NotificationHubConfiguration.Json);
		Task<object?> Call(string method, object v, CancellationToken token = default) => workspace.ExecuteAsync(method, Input(v), _ => Task.CompletedTask, token);
		var connected = (NotificationHubConnection)(await Call("nh.connect", new
		{
			operationId = Guid.NewGuid().ToString(),
			profile = new
			{
				id = Guid.NewGuid().ToString(),
				service = "notification-hubs",
				@namespace = "fixture.servicebus.windows.net"
			},
			management = new NotificationHubManagement(FixtureNotificationHubFactory.Root, "fixture", Guid.NewGuid().ToString())
		}))!;
		var archive = new NotificationHubConfigArchive(NotificationHubConfiguration.Format, 1, DateTimeOffset.UtcNow.ToString("O"), "source", [new("alerts", new("30.00:00:00", [new("purpose", "import")]), [], true)], [], []);
		var previous = JsonSerializer.SerializeToUtf8Bytes(archive with
		{
			Format = "service-bus-commander/notification-hubs"
		}, NotificationHubConfiguration.Json);
		var restored = NotificationHubConfiguration.Decode(Convert.ToBase64String(previous));
		Assert(restored.Format == NotificationHubConfiguration.Format && restored.Resources[0].Name == "alerts", "Previous product exports retain settings and normalize their format");
		async Task<NotificationHubConfigPreview> Preview(NotificationHubConfigArchive value) => (NotificationHubConfigPreview)(await Call("nh.config.preview", new
		{
			id = Guid.NewGuid().ToString(),
			connectionId = connected.ConnectionId,
			contentBase64 = Convert.ToBase64String(NotificationHubConfiguration.Encode(value, "json"))
		}))!;
		object Apply(NotificationHubConfigPreview plan) => new
		{
			id = Guid.NewGuid().ToString(),
			connectionId = connected.ConnectionId,
			importId = plan.ImportId,
			entryIds = plan.Entries.Select(e => e.Id).ToArray(),
			acknowledged = true
		};
		var preview = await Preview(archive);
		wire.MalformedPatchReply = true;
		var receipt = (NotificationHubConfigResult)(await Call("nh.config.apply", Apply(preview)))!;
		Assert(receipt.Status == "completed", "HTTP acknowledgment survives malformed unused response body");
		var raw = wire.Data("/notificationHubs/alerts");
		Assert(raw["properties"]!["gcmCredential"]!["properties"]!["googleApiKey"]!.ToString() == "SECRET-PNS", "Provider credentials preserved");
		Assert(raw["properties"]!["futureSetting"]!.ToString() == "preserved" && raw["properties"]!["authorizationRules"]![0]!["primaryKey"]!.ToString() == "SECRET-EMBEDDED-KEY", "Unrelated Azure settings and keys preserved");
		Assert(wire.Requests.All(r => !r.Path.Contains("listKeys") && !r.Path.Contains("regenerateKeys")), "Configuration never requests keys");
		Assert(JsonNode.Parse(wire.Requests.Single(r => r.Method == "PATCH").Body!)!["properties"]!.AsObject().Count == 1, "Only represented settings sent");
		wire.MalformedPatchReply = false;
		preview = await Preview(archive);
		clock.Now = clock.Now.AddMinutes(11);
		var writes = wire.Requests.Count(r => r.Method != "GET");
		try
		{
			await Call("nh.config.apply", Apply(preview));
			throw new Exception("Expired preview accepted");
		}
		catch (OperationException) { }
		Assert(wire.Requests.Count(r => r.Method != "GET") == writes, "Expired preview dispatches no write");
		preview = await Preview(archive);
		using var cancel = new CancellationTokenSource();
		wire.BeforeRequest = (method, path) => { if (method == "GET" && path.EndsWith("/alerts")) cancel.Cancel(); };
		receipt = (NotificationHubConfigResult)(await Call("nh.config.apply", Apply(preview), cancel.Token))!;
		Assert(receipt.Status == "cancelled" && receipt.Steps[0].Status == "cancelled", "Pre-dispatch cancellation is known");
		Assert(wire.Requests.Count(r => r.Method != "GET") == writes, "Preflight cancellation dispatches no write");
		wire.BeforeRequest = null;
		preview = await Preview(archive with
		{
			Resources = [new("late-import", new("30.00:00:00", []), [], true)]
		});
		using var late = new CancellationTokenSource();
		wire.BeforeRequest = (method, path) => { if (method == "PUT" && path.EndsWith("/late-import")) late.CancelAfter(100); };
		receipt = (NotificationHubConfigResult)(await Call("nh.config.apply", Apply(preview), late.Token))!;
		Assert(receipt.Status == "completed" && receipt.Steps[0].Status == "confirmed", "Acknowledged write wins over late cancellation");
		wire.BeforeRequest = null;
		var reachedCap = false;
		for (var index = 0; index < 20; index++)
		{
			preview = await Preview(archive);
			try
			{
				await Call("nh.config.apply", Apply(preview));
			}
			catch (OperationException error) when (error.Failure == OperationFailure.OperationBlocked) { reachedCap = true; break; }
		}
		Assert(reachedCap, "Receipt cap is reached through public operations");
		preview = await Preview(archive);
		writes = wire.Requests.Count(r => r.Method != "GET");
		try
		{
			await Call("nh.config.apply", Apply(preview));
			throw new Exception("Receipt cap bypassed");
		}
		catch (OperationException) { }
		Assert(wire.Requests.Count(r => r.Method != "GET") == writes, "Receipt limit is checked before dispatch");
		wire.NextLinkOverride = "https://management.azure.com" + FixtureNotificationHubFactory.Root + "/notificationHubs?api-version=2023-09-01&page=1";
		try
		{
			await Call("nh.config.export", new
			{
				id = Guid.NewGuid().ToString(),
				connectionId = connected.ConnectionId,
				scope = new NotificationHubScope("namespace", ""),
				format = "json"
			});
			throw new Exception("Repeated pagination accepted");
		}
		catch (OperationException) { }
		Assert(!JsonSerializer.Serialize(receipt).Contains("SECRET"), "Receipts redact transport credentials");
		await Call("nh.reset", new
		{
		});
		try
		{
			await Call("nh.config.apply", Apply(preview));
			throw new Exception("Reset plan accepted");
		}
		catch (OperationException) { }
		Console.WriteLine("Notification Hubs configuration checks passed");
		return 0;
	}
}
