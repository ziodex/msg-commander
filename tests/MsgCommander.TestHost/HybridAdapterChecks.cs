using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using Microsoft.Azure.Relay;
using MsgCommander.Host;

static class HybridAdapterChecks
{
	private static void Check(bool condition, string message)
	{
		if (!condition)
			throw new Exception(message);
	}
	private static HybridRun Request(string mode = "http-send") => new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "team/bridge", mode, "POST", "{\"hello\":true}", "utf8", [], 200, 1, 10, 2, true);
	private static readonly TokenProvider Provider = TokenProvider.CreateSharedAccessSignatureTokenProvider("sender", "OFFLINE-KEY");
	public static async Task<int> Run()
	{
		var checks = new List<string>();
		var request = Request();
		request.Validate();
		foreach (var invalid in new[] { request with { Acknowledged = false }, request with { Name = "a/../b" }, request with { Body = new string('x', 16385) }, request with { Headers = [new("ServiceBusAuthorization", "SECRET")] }, request with { Headers = [new("x-test", "one\r\ntwo")] }, request with { MaxCount = 101 }, request with { Encoding = "base64", Body = "Zh==" }, request with { Mode = "stream-send", Headers = [new("X-Test", "a")] } })
		{
			try
			{
				invalid.Validate();
				throw new Exception("Validation failed to reject.");
			}
			catch (OperationException) { }
		}
		checks.Add("independent validation, canonical binary, scope, header and bound rejection");
		var raw = Enumerable.Range(0, 16384).Select(i => (byte)i).ToArray();
		var exact = await AzureHybridGateway.ReadBody(new MemoryStream(raw), CancellationToken.None);
		var large = await AzureHybridGateway.ReadBody(new MemoryStream(raw.Concat(new byte[] { 1 }).ToArray()), CancellationToken.None);
		Check(exact.Bytes.SequenceEqual(raw) && !exact.Truncated && large.Truncated && large.Bytes.Length == 16384, "body cap");
		var headers = AzureHybridGateway.CaptureHeaders([new("Authorization", "SECRET"), new("Cookie", "SECRET"), new("Set-Cookie", "SECRET"), new("Content-Type", "application/json"), new("x-over", new string('x', 1025))]);
		Check(headers.Count == 1 && headers[0].Name == "Content-Type", "header redaction");
		checks.Add("bounded byte capture and secret-header exclusion");
		var profile = new ConnectionProfile(request.ProfileId, "test", "relay", "fixture.servicebus.windows.net", "sas", "", "", "Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=sender;SharedAccessKey=OFFLINE-KEY;EntityPath=team/bridge");
		await using (var valid = new AzureHybridGatewayFactory().Create(profile, request, _ => Task.CompletedTask, CancellationToken.None))
		{
		}
		foreach (var secret in new[] { profile.Secret!.Replace("fixture.servicebus", "other.servicebus"), profile.Secret.Replace("team/bridge", "another"), profile.Secret.Replace(".net/;", ".net/path/;"), profile.Secret.Replace("sb://", "https://") })
		{
			try
			{
				await using var bad = new AzureHybridGatewayFactory().Create(profile with
				{
					Secret = secret
				}, request, _ => Task.CompletedTask, CancellationToken.None);
				throw new Exception("SAS scope not rejected.");
			}
			catch (OperationException) { }
		}
		checks.Add("production SAS endpoint and entity pinning without network");
		var wire = new Wire();
		await using (var gateway = new AzureHybridGateway(new("sb://fixture.servicebus.windows.net/team/bridge"), Provider, wire))
		{
			HybridExchange? result = null;
			await gateway.RunAsync(request, x => { result = x; return false; }, _ => { }, CancellationToken.None);
			Check(result is { StatusCode: 202, Outcome: "confirmed" } && Encoding.UTF8.GetString(Convert.FromBase64String(result.ResponseBody)) == "{\"ok\":true}", "HTTP response");
			Check(wire.Calls == 1 && wire.Target == "https://fixture.servicebus.windows.net/team/bridge" && wire.Auth && wire.Body == request.Body, "fixed HTTP dispatch");
			Check(result!.ResponseHeaders.All(h => h.Name != "Set-Cookie"), "response credential stripped");
		}
		wire = new()
		{
			Fail = true
		};
		await using (var gateway = new AzureHybridGateway(new("sb://fixture.servicebus.windows.net/team/bridge"), Provider, wire))
		{
			HybridExchange? result = null;
			await gateway.RunAsync(request, x => { result = x; return false; }, _ => { }, CancellationToken.None);
			Check(result?.Outcome == "unknown" && wire.Calls == 1 && !result.Summary.Contains("SECRET"), "unknown/no retry");
		}
		checks.Add("production HTTP request target, body, SAS header, response and uncertain dispatch without retries");
		// Real SDK WebSocketStream on two .NET WebSockets over loopback sockets. No Azure credentials/network.
		var server = new TcpListener(IPAddress.Loopback, 0);
		server.Start();
		using var client = new TcpClient();
		var accepting = server.AcceptTcpClientAsync();
		await client.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)server.LocalEndpoint).Port);
		using var accepted = await accepting;
		server.Stop();
		using var ws1 = WebSocket.CreateFromStream(client.GetStream(), false, null, TimeSpan.FromSeconds(30));
		using var ws2 = WebSocket.CreateFromStream(accepted.GetStream(), true, null, TimeSpan.FromSeconds(30));
		var sdkType = typeof(HybridConnectionStream).Assembly.GetType("Microsoft.Azure.Relay.WebSocketStream")!;
		HybridConnectionStream Wrap(WebSocket ws) => (HybridConnectionStream)Activator.CreateInstance(sdkType, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null, [ws, new HybridConnectionListener(new Uri("sb://fixture.servicebus.windows.net/bridge"), Provider).TrackingContext], null)!;
		await using (var first = new AzureHybridGateway(new("sb://fixture.servicebus.windows.net/team/bridge"), Provider))
		await using (var second = new AzureHybridGateway(new("sb://fixture.servicebus.windows.net/team/bridge"), Provider))
		{
			using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(5));
			var sender = request with
			{
				Mode = "stream-send",
				Encoding = "base64",
				Body = Convert.ToBase64String(new byte[] { 0, 255, 123, 10 })
			};
			var receiver = request with
			{
				Mode = "stream-listen",
				Body = "reply"
			};
			var result = await Task.WhenAll(first.StreamExchange(Wrap(ws1), sender, false, stop.Token), second.StreamExchange(Wrap(ws2), receiver, true, stop.Token));
			Check(result.All(x => x.Outcome == "confirmed") && result[0].ResponseBody == Convert.ToBase64String("reply"u8) && result[1].RequestBody == sender.Body, "SDK binary half-close round trip");
		}
		checks.Add("actual Relay SDK stream binary round trip, half-close, EOF and cleanup");
		Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new
		{
			checks
		}));
		return 0;
	}
	private sealed class Wire : HttpMessageHandler
	{
		public int Calls; public string? Target; public string? Body; public bool Auth; public bool Fail;
		protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation)
		{
			Calls++;
			Target = request.RequestUri!.AbsoluteUri;
			Auth = request.Headers.Contains("ServiceBusAuthorization");
			Body = await request.Content!.ReadAsStringAsync(cancellation);
			if (Fail)
				throw new IOException("SECRET transport failure");
			var response = new HttpResponseMessage(HttpStatusCode.Accepted) { Content = new StringContent("{\"ok\":true}") };
			response.Headers.TryAddWithoutValidation("Set-Cookie", "SECRET");
			return response;
		}
	}
}
