using System.Net;
using System.Text.Json;
using MsgCommander.Host;
static class NotificationTestSendChecks
{
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	static string Id() => Guid.NewGuid().ToString();
	static NotificationDraft Draft(string format = "apple", string target = "tags", string tags = "sports && !muted") => new(format, target, target == "tags" ? tags : "", format switch { "template" => "", "apple" => "{\"aps\":{\"alert\":\"Hello\"}}", "FcmV1" => "{\"message\":{\"notification\":{\"body\":\"Hello\"}}}", "windows" => "<toast><visual/></toast>", "windowsphone" => "<wp:Notification xmlns:wp=\"WPNotification\"><wp:Toast/></wp:Notification>", "adm" => "{\"data\":{\"message\":\"Hello\"}}", _ => "{\"title\":\"Commander\",\"description\":\"Hello\"}" }, format == "template" ? [new("message", "Hello"), new("title", "Commander")] : [], format == "windows" ? [new("X-WNS-Type", "wns/toast")] : format == "windowsphone" ? [new("X-WindowsPhone-Target", "toast"), new("X-NotificationClass", "2")] : []);
	static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	sealed class Factory(NotificationTestSendWire wire) : INotificationHubRegistrationsGatewayFactory
	{
		public INotificationHubRegistrationsGateway Create(ConnectionProfile profile, string hub) => new AzureNotificationHubRegistrationsGateway(profile, hub, wire);
	}
	public static async Task<int> Run()
	{
		var profile = new ConnectionProfile(Id(), "Fixture", "notification-hubs", "fixture.servicebus.windows.net", "sas", "", "", "Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Send;SharedAccessKey=OFFLINE-NH-KEY;");
		var wire = new NotificationTestSendWire();
		await using var admin = new NotificationHubWorkspace(new FixtureNotificationHubFactory());
		await using var workspace = new NotificationHubNotificationsWorkspace(new Factory(wire), admin);
		async Task<T> Execute<T>(string method, object input) => (T)(await workspace.ExecuteAsync(method, JsonSerializer.SerializeToElement(input, Json), CancellationToken.None))!;
		var setup = new NotificationHubRegistrationsConnect(Id(), profile.Id, "alerts", "profile", null, null, null);
		var connection = await Execute<NotificationHubRegistrationsConnection>("nh.notifications.connect", new
		{
			request = setup,
			profile
		});
		var operation = Id();
		var send = new NotificationTestSend(operation, connection.ConnectionId, Draft(), true);
		var result = await Execute<NotificationSendOutcome>("nh.notifications.send", send);
		Assert(result.Status == "confirmed" && result.Details?.Success == 1 && result.Details.Results.Single().RegistrationId == "apple-native" && result.Details.NotificationId == "notification-123", "Tag Boolean targeting and detailed outcome");
		Assert(wire.Sent.Count == 1 && wire.Sent[0].Uri.Query.EndsWith("&test") && wire.Sent[0].Format == "apple" && wire.Sent[0].Tags == "sports && !muted" && wire.Sent[0].ContentType == "application/json", "Debug route and headers");
		Assert(await Execute<NotificationSendOutcome>("nh.notifications.send", send) == result && wire.Sent.Count == 1, "Immutable receipt does not resend");
		try
		{
			await Execute<NotificationSendOutcome>("nh.notifications.send", send with
			{
				Draft = Draft(tags: "sports")
			});
			throw new Exception("Altered replay accepted");
		}
		catch (OperationException) { }
		foreach (var format in new[] { "apple", "FcmV1", "windows", "windowsphone", "adm", "baidu", "browser", "template" })
		{
			var sent = await Execute<NotificationSendOutcome>("nh.notifications.send", new NotificationTestSend(Id(), connection.ConnectionId, Draft(format, "broadcast"), true));
			Assert(sent.Status == "confirmed" && wire.Sent.Last().Format == format && wire.Sent.Last().Tags is null, "Native/template broadcast formats");
			if (format == "template")
			{
				using var body = JsonDocument.Parse(wire.Sent.Last().Body);
				Assert(body.RootElement.GetProperty("message").GetString() == "Hello" && body.RootElement.GetProperty("title").GetString() == "Commander", "Template string parameters");
			}
		}
		var failure = await Execute<NotificationSendOutcome>("nh.notifications.send", new NotificationTestSend(Id(), connection.ConnectionId, Draft(tags: "sports"), true));
		Assert(failure.Details?.Failure == 1 && failure.Details.Results.Any(r => r.Outcome == "InvalidToken"), "Provider failures retained alongside Azure acknowledgment");
		foreach (var expression in new[] { "news &&", "a | b", "a b", "()", "a;header", new string('!', 18) + "a", string.Join(" || ", Enumerable.Repeat("a", 21)), string.Join(" && ", Enumerable.Repeat("a", 11)), "a && b && c || d || e || f || g" })
		{
			try
			{
				NotificationTagExpression.Validate(expression);
				throw new Exception("Invalid expression accepted");
			}
			catch (OperationException) { }
		}
		foreach (var bad in new[] { Draft() with { Body = "[]" }, Draft() with { Body = "{\"aps\":42}" }, Draft("FcmV1") with { Body = "{\"notification\":{}}" }, Draft() with { Headers = [new("Authorization", "override")] }, Draft() with { Headers = [new("apns-topic", "x\r\ny")] }, Draft("windows") with { Body = "<!DOCTYPE toast [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><toast>&e;</toast>" }, Draft("template") with { Parameters = [new("title", "one"), new("TITLE", "two")] }, Draft() with { Target = "broadcast" }, Draft() with { Body = new string('x', 65537) } })
		{
			try
			{
				bad.Validate();
				throw new Exception("Invalid draft accepted");
			}
			catch (OperationException) { }
		}
		foreach (var code in new[] { HttpStatusCode.BadRequest, HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden, HttpStatusCode.NotFound, HttpStatusCode.RequestEntityTooLarge, HttpStatusCode.TooManyRequests, HttpStatusCode.InternalServerError, HttpStatusCode.RequestTimeout })
		{
			wire.Status = code;
			var denied = await Execute<NotificationSendOutcome>("nh.notifications.send", new NotificationTestSend(Id(), connection.ConnectionId, Draft(), true));
			Assert(denied.Status == ((int)code >= 500 || code == HttpStatusCode.RequestTimeout ? "unknown" : "failed") && !denied.Summary.Contains("SECRET"), "Definite rejection versus uncertain dispatch");
		}
		wire.Status = null;
		wire.LoseResponse = true;
		var lost = await Execute<NotificationSendOutcome>("nh.notifications.send", new NotificationTestSend(Id(), connection.ConnectionId, Draft(), true));
		Assert(lost.Status == "unknown", "Lost response uncertain");
		wire.LoseResponse = false;
		wire.XmlOverride = "<invalid>";
		var malformed = await Execute<NotificationSendOutcome>("nh.notifications.send", new NotificationTestSend(Id(), connection.ConnectionId, Draft(), true));
		Assert(malformed.Status == "confirmed" && malformed.Details?.Warning is not null && malformed.Details.Success is null, "Acknowledgment survives malformed detail");
		wire.XmlOverride = null;
		wire.Location = "https://evil.example/alerts/messages/secret";
		var foreign = await Execute<NotificationSendOutcome>("nh.notifications.send", new NotificationTestSend(Id(), connection.ConnectionId, Draft(), true));
		Assert(foreign.Details!.NotificationId is null, "Foreign Location not trusted or followed");
		wire.Location = null;
		using var late = new CancellationTokenSource();
		wire.OnAcknowledged = () => late.Cancel();
		var acknowledged = (NotificationSendOutcome)(await workspace.ExecuteAsync("nh.notifications.send", JsonSerializer.SerializeToElement(new NotificationTestSend(Id(), connection.ConnectionId, Draft(), true), Json), late.Token))!;
		Assert(acknowledged.Status == "confirmed" && acknowledged.Details?.Success == 1, "Late cancellation cannot erase acknowledgment");
		wire.OnAcknowledged = null;
		await workspace.ExecuteAsync("nh.notifications.reset", JsonSerializer.SerializeToElement(new
		{
		}), CancellationToken.None);
		try
		{
			await Execute<NotificationSendOutcome>("nh.notifications.send", send);
			throw new Exception("Stale connection accepted");
		}
		catch (OperationException) { }
		Console.WriteLine("Notification test send adapter/workspace checks passed");
		return 0;
	}
}
