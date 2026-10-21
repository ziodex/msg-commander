using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MsgCommander.Host;
static class NotificationHubRegistrationsAdapterChecks
{
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	public static ConnectionProfile Profile(string? secret = null) => new(Guid.NewGuid().ToString(), "Registrations", "notification-hubs", "fixture.servicebus.windows.net", "sas", "", "", secret ?? "Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Manage;SharedAccessKey=OFFLINE-NH-KEY;");
	public static async Task<int> Run()
	{
		var wire = new NotificationHubRegistrationsWire();
		await using var gateway = new AzureNotificationHubRegistrationsGateway(Profile(), "alerts", wire);
		var all = new NotificationHubRegistrationQuery("all", "", "any", 25);
		var first = await gateway.QueryAsync(all, null, default);
		Assert(first.Items.Count == 2 && first.ContinuationToken == "opaque+/=&:2", "First page and raw token");
		Assert(first.Items[0].Registration.Platform == "APNS" && first.Items[0].Etag == "W/\"42\"", "Native identity and feed ETag");
		var template = first.Items[1];
		Assert(template.Registration.Template && template.Registration.Platform == "FCM v1" && template.TemplateBody!.Contains("$(title)") && template.RawXml.Contains("FutureProperty"), "Templates, CDATA and unrecognized fields preserved");
		var seen = first.Items.ToList();
		var token = first.ContinuationToken;
		while (token is not null)
		{
			var page = await gateway.QueryAsync(all, token, default);
			seen.AddRange(page.Items);
			token = page.ContinuationToken;
		}
		Assert(seen.Select(i => i.Registration.RegistrationId).SequenceEqual(NotificationHubRegistrationsWire.Data.Select(d => d.Id)), "Every page without skips/repeats");
		Assert(seen.Single(i => i.Registration.RegistrationId == "future-native").Warning is not null, "Unknown types retained");
		Assert(seen.Single(i => i.Registration.Platform == "Baidu").RawXml.Contains("baidu-channel"), "Baidu secondary handle retained");
		var tag = await gateway.QueryAsync(new("tag", "customer:123", "any", 25), null, default);
		Assert(tag.Items.Count == 2 && wire.Requests.Last().Uri.AbsolutePath.Contains("customer%3A123", StringComparison.OrdinalIgnoreCase), "Exact tag encoded as segment");
		var handle = NotificationHubRegistrationsWire.Data[1].Handle;
		var filtered = await gateway.QueryAsync(new("handle", handle, "any", 25), null, default);
		Assert(filtered.Items.Single().Registration.RegistrationId == "fcm-template", "Quoted handle round trip");
		var decoded = Uri.UnescapeDataString(wire.Requests.Last().Uri.Query);
		Assert(decoded.Contains("ChannelUri eq 'fcm-token-''quoted''&value=one'"), "OData quote escaping before URL escaping");
		Assert((await gateway.QueryAsync(new("handle", new string('a', 64), "apns", 25), null, default)).Items.Single().Registration.Platform == "APNS", "APNS uppercased");
		Assert((await gateway.QueryAsync(new("handle", NotificationHubRegistrationsWire.Data[2].Handle, "wns", 25), null, default)).Items.Single().Registration.Platform == "WNS", "WNS URL is data, not request destination");
		Assert((await gateway.QueryAsync(new("tag", "empty", "any", 25), null, default)).Items.Count == 0, "Empty feed");
		foreach (var secret in new[] { "Endpoint=sb://evil.invalid/;SharedAccessKeyName=x;SharedAccessKey=y", "Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=x;SharedAccessKey=y;EntityPath=other", "Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=x;SharedAccessKey=y;Endpoint=sb://fixture.servicebus.windows.net/", "Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessSignature=SECRET", "Endpoint=sb://fixture.servicebus.windows.net/?x=y;SharedAccessKeyName=x;SharedAccessKey=y" })
		{
			try
			{
				await using var invalid = new AzureNotificationHubRegistrationsGateway(Profile(secret), "alerts", new NotificationHubRegistrationsWire());
				throw new Exception("Invalid SAS scope accepted");
			}
			catch (OperationException e) { Assert(!e.Message.Contains("SECRET"), "SAS errors sanitized"); }
		}
		foreach (var query in new[] { new NotificationHubRegistrationQuery("tag", "..", "any", 25), new("handle", "bad", "apns", 25), new("handle", "http://bad", "wns", 25), new("all", "", "any", 101) })
		{
			var count = wire.Requests.Count;
			try
			{
				await gateway.QueryAsync(query, null, default);
				throw new Exception("Invalid query sent");
			}
			catch (OperationException) { }
			Assert(wire.Requests.Count == count, "Validate before sending credentials");
		}
		foreach (var xml in new[] { "<!DOCTYPE feed [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><feed xmlns='http://www.w3.org/2005/Atom'>&xxe;</feed>", "<feed>", "<feed xmlns='http://www.w3.org/2005/Atom'><entry><content><Invalid /></content></entry></feed>", new string('x', 2097153), "<feed xmlns='http://www.w3.org/2005/Atom'>" + string.Concat(Enumerable.Repeat("<n>", 40)) + string.Concat(Enumerable.Repeat("</n>", 40)) + "</feed>" })
		{
			wire.XmlOverride = xml;
			try
			{
				await gateway.QueryAsync(all, null, default);
				throw new Exception("Invalid/oversize feed accepted");
			}
			catch (OperationException e) { Assert(!e.Message.Contains("passwd"), "Parser errors sanitized"); }
		}
		wire.XmlOverride = null;
		wire.StatusOverride = System.Net.HttpStatusCode.Redirect;
		var before = wire.Requests.Count;
		try
		{
			await gateway.QueryAsync(all, null, default);
			throw new Exception("Redirect accepted");
		}
		catch (OperationException) { }
		Assert(wire.Requests.Count == before + 1, "No redirects/retries");
		wire.StatusOverride = System.Net.HttpStatusCode.Unauthorized;
		try
		{
			await gateway.QueryAsync(all, null, default);
			throw new Exception("Unauthorized accepted");
		}
		catch (OperationException e) { Assert(e.Message.Contains("Manage") && !e.Message.Contains("SECRET"), "Useful redacted error"); }
		wire.StatusOverride = null;
		using var cancellation = new CancellationTokenSource(50);
		try
		{
			await gateway.QueryAsync(new("tag", "slow", "any", 25), null, cancellation.Token);
			throw new Exception("Cancellation ignored");
		}
		catch (OperationCanceledException) { }
		var signed = AzureNotificationHubRegistrationsGateway.Sign("https://fixture.servicebus.windows.net/alerts", "Manage", "test-key", 1800000000);
		var fields = signed["SharedAccessSignature ".Length..].Split('&').Select(p => p.Split('=', 2)).ToDictionary(p => p[0], p => p[1]);
		var expected = Convert.ToBase64String(HMACSHA256.HashData(Encoding.UTF8.GetBytes("test-key"), Encoding.UTF8.GetBytes(fields["sr"] + "\n1800000000")));
		Assert(Uri.UnescapeDataString(fields["sig"]) == expected && Uri.UnescapeDataString(fields["sr"]) == "https://fixture.servicebus.windows.net/alerts", "Documented UTF8-key SAS contract");
		var pagingWire = new NotificationHubRegistrationsWire { XmlOverride = "<feed xmlns='http://www.w3.org/2005/Atom'/>", NextOverride = "opaque+/=&:2" };
		await using var admin = new NotificationHubWorkspace(new FixtureNotificationHubFactory());
		await using var workspace = new NotificationHubRegistrationsWorkspace(new CheckFactory(pagingWire), admin);
		var profile = Profile();
		var setup = new NotificationHubRegistrationsConnect(Guid.NewGuid().ToString(), profile.Id, "alerts", "profile", null, null, null);
		var connection = (NotificationHubRegistrationsConnection)(await workspace.ExecuteAsync("nh.registrations.connect", JsonSerializer.SerializeToElement(new
		{
			request = setup,
			profile
		}, new JsonSerializerOptions(JsonSerializerDefaults.Web)), default))!;
		async Task<NotificationHubRegistrationsPage> Page(string? continuation) => (NotificationHubRegistrationsPage)(await workspace.ExecuteAsync("nh.registrations.query", JsonSerializer.SerializeToElement(new
		{
			id = Guid.NewGuid().ToString(),
			connectionId = connection.ConnectionId,
			query = all,
			continuationToken = continuation
		}, new JsonSerializerOptions(JsonSerializerDefaults.Web)), default))!;
		var empty = await Page(null);
		Assert(empty.Items.Count == 0 && empty.ContinuationToken is not null, "Empty pages retain valid next handles");
		pagingWire.NextOverride = "opaque+/=&:4";
		var emptyNext = await Page(empty.ContinuationToken);
		pagingWire.NextOverride = "opaque+/=&:2";
		try
		{
			await Page(emptyNext.ContinuationToken);
			throw new Exception("Cyclic cursor accepted");
		}
		catch (OperationException) { }
		pagingWire.NextOverride = null;
		pagingWire.XmlOverride = "<feed xmlns='http://www.w3.org/2005/Atom'><entry><content><AppleTemplateRegistrationDescription xmlns='http://schemas.microsoft.com/netservices/2010/10/servicebus/connect'><RegistrationId>escaped</RegistrationId><BodyTemplate><![CDATA[" + new string('<', 110000) + "]]></BodyTemplate></AppleTemplateRegistrationDescription></content></entry></feed>";
		try
		{
			await Page(null);
			throw new Exception("IPC oversized inspection accepted");
		}
		catch (OperationException) { }
		Console.WriteLine("Notification Hubs registration adapter checks passed");
		return 0;
	}
	private sealed class CheckFactory(NotificationHubRegistrationsWire wire) : INotificationHubRegistrationsGatewayFactory
	{
		public INotificationHubRegistrationsGateway Create(ConnectionProfile profile, string hubName) => new AzureNotificationHubRegistrationsGateway(profile, hubName, wire);
	}
}
