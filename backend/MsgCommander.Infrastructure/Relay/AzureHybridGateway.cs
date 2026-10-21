using System.Net;
using System.Text;
using System.Threading.Channels;
using Microsoft.Azure.Relay;
using Azure.Core;

namespace MsgCommander.Infrastructure.Relay;

public sealed class AzureHybridGatewayFactory : IHybridGatewayFactory
{
	public IHybridGateway Create(ConnectionProfile profile, HybridRun request, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		var address = new Uri($"sb://{profile.Namespace}/{string.Join('/', request.Name.Split('/').Select(Uri.EscapeDataString))}");
		TokenProvider provider;
		if (profile.Auth == "sas")
		{
			RelayConnectionStringBuilder parsed;
			try
			{
				parsed = new(profile.Secret);
			}
			catch (Exception)
			{
				throw HybridRunRules.Invalid();
			}

			if (parsed.Endpoint is null || parsed.Endpoint.Scheme != "sb" || !string.Equals(parsed.Endpoint.Host, profile.Namespace, StringComparison.OrdinalIgnoreCase) || !parsed.Endpoint.IsDefaultPort || parsed.Endpoint.AbsolutePath != "/" || parsed.Endpoint.Query != "" || parsed.Endpoint.Fragment != "" || parsed.Endpoint.UserInfo != "" || (!string.IsNullOrEmpty(parsed.EntityPath) && parsed.EntityPath != request.Name) || string.IsNullOrEmpty(parsed.SharedAccessKeyName) || string.IsNullOrEmpty(parsed.SharedAccessKey) || !string.IsNullOrEmpty(parsed.SharedAccessSignature))
				throw new OperationException(OperationFailure.InvalidInput, "Use a Relay SAS key connection string matching the profile namespace and selected Hybrid Connection. Signed token strings are not supported.");
			provider = TokenProvider.CreateSharedAccessSignatureTokenProvider(parsed.SharedAccessKeyName, parsed.SharedAccessKey);
		}
		else
		{
			var credential = MsgCommander.Infrastructure.Authentication.AzureDeviceCodeCredential.Create(profile.TenantId, profile.ClientId, deviceCode);
			provider = TokenProvider.CreateAzureActiveDirectoryTokenProvider(async (_, _, _) => (await credential.GetTokenAsync(new TokenRequestContext(["https://relay.azure.net/.default"]), cancellation)).Token, $"https://login.microsoftonline.com/{profile.TenantId}", null);
		}

		return new AzureHybridGateway(address, provider);
	}
}

public sealed class AzureHybridGateway : IHybridGateway
{
	private readonly Uri address;
	private readonly TokenProvider provider;
	private readonly HttpClient http;
	public AzureHybridGateway(Uri address, TokenProvider provider) : this(address, provider, new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, MaxResponseHeadersLength = 16, ConnectTimeout = TimeSpan.FromSeconds(10) })
	{
	}

	internal AzureHybridGateway(Uri address, TokenProvider provider, HttpMessageHandler transport)
	{
		this.address = address;
		this.provider = provider;
		http = new(transport)
		{
			Timeout = Timeout.InfiniteTimeSpan
		};
	}

	private bool cleanupFailed;
	private Task? responseClose;
	private HybridConnectionListener? listener;
	private readonly Channel<RelayedHttpListenerContext> requests = Channel.CreateBounded<RelayedHttpListenerContext>(1);
	private int admitted;
	private bool closed;
	public async Task RunAsync(HybridRun request, Func<HybridExchange, bool> record, Action<string> phase, CancellationToken cancellation)
	{
		if (request.Mode.EndsWith("listen", StringComparison.Ordinal))
		{
			listener = new HybridConnectionListener(address, provider);
			listener.Connecting += (_, _) => phase("reconnecting");
			listener.Online += (_, _) => phase("online");
			listener.Offline += (_, _) => phase("reconnecting");
			listener.AcceptHandler = context =>
			{
				var accepted = request.Mode == "stream-listen" && !cancellation.IsCancellationRequested && Interlocked.CompareExchange(ref admitted, 1, 0) == 0;
				if (!accepted)
					context.Response.StatusCode = HttpStatusCode.ServiceUnavailable;
				return Task.FromResult(accepted);
			};
			listener.RequestHandler = context =>
			{
				if (request.Mode != "http-listen" || cancellation.IsCancellationRequested || Interlocked.CompareExchange(ref admitted, 1, 0) != 0)
				{
					Reject(context);
					return;
				}

				if (!requests.Writer.TryWrite(context))
				{
					Interlocked.Exchange(ref admitted, 0);
					Reject(context);
				}
			};
			await listener.OpenAsync(cancellation);
			phase("online");
		}

		for (var index = 0; index < request.MaxCount; index++)
		{
			cancellation.ThrowIfCancellationRequested();
			HybridExchange exchange;
			if (request.Mode == "http-listen")
			{
				var context = await requests.Reader.ReadAsync(cancellation);
				phase("exchanging");
				using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
				deadline.CancelAfter(TimeSpan.FromSeconds(request.ExchangeSeconds));
				exchange = await RespondHttp(context, request, deadline.Token);
			}
			else if (request.Mode == "stream-listen")
			{
				// CloseAsync drains/aborts an outstanding accept when cancelled.
				var pending = listener!.AcceptConnectionAsync();
				HybridConnectionStream? stream;
				try
				{
					stream = await pending.WaitAsync(cancellation);
				}
				catch
				{
					await CloseListener();
					var late = await pending.WaitAsync(TimeSpan.FromSeconds(2));
					if (late is not null)
						CloseStream(late);
					throw;
				}

				if (stream is null)
					throw new IOException("Listener closed.");
				phase("exchanging");
				using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
				deadline.CancelAfter(TimeSpan.FromSeconds(request.ExchangeSeconds));
				exchange = await StreamExchange(stream, request, true, deadline.Token);
			}
			else
			{
				phase("exchanging");
				using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
				deadline.CancelAfter(TimeSpan.FromSeconds(request.ExchangeSeconds));
				exchange = request.Mode == "http-send" ? await SendHttp(request, deadline.Token) : await SendStream(request, deadline.Token);
			}

			Interlocked.Exchange(ref admitted, 0);
			if (!record(exchange) || exchange.Outcome == "unknown")
				break;
			phase(request.Mode.EndsWith("listen", StringComparison.Ordinal) ? "online" : "exchanging");
		}
	}

	private static void Reject(RelayedHttpListenerContext context)
	{
		// The SDK owns a bounded response timeout. Never queue additional application work.
		try
		{
			context.Response.StatusCode = HttpStatusCode.ServiceUnavailable;
			context.Response.Close();
		}
		catch (Exception)
		{
		}
	}

	private static HybridExchange Result(string method, int? status, string outcome, byte[] request, byte[] response, bool requestTruncated = false, bool responseTruncated = false, IReadOnlyList<HybridHeader>? requestHeaders = null, IReadOnlyList<HybridHeader>? responseHeaders = null) => new(1, DateTimeOffset.UtcNow.ToString("O"), method, status, outcome, Convert.ToBase64String(request), Convert.ToBase64String(response), requestTruncated, responseTruncated, requestHeaders ?? [], responseHeaders ?? [], outcome == "unknown" ? "Exchange interrupted; the peer may have received bytes. No retry." : outcome == "rejected" ? "The exchange was rejected or exceeded the 16 KiB capture limit." : "Exchange completed.");
	public static async Task<(byte[] Bytes, bool Truncated)> ReadBody(Stream stream, CancellationToken cancellation)
	{
		using var output = new MemoryStream();
		var buffer = new byte[4096];
		while (true)
		{
			var count = await stream.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, HybridRunRules.BodyLimit + 1 - (int)output.Length)), cancellation);
			if (count == 0)
				return (output.ToArray(), false);
			await output.WriteAsync(buffer.AsMemory(0, count), cancellation);
			if (output.Length > HybridRunRules.BodyLimit)
				return (output.ToArray()[..HybridRunRules.BodyLimit], true);
		}
	}

	public static IReadOnlyList<HybridHeader> CaptureHeaders(IEnumerable<HybridHeader> headers)
	{
		var result = new List<HybridHeader>();
		foreach (var h in headers)
		{
			if (!HybridRunRules.ValidHeader(h) || !HybridRunRules.AllowedHeader(h.Name))
				continue;
			if (System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(result.Append(h)).Length > 4096 || result.Count >= 16)
				break;
			result.Add(h);
		}

		return result;
	}

	private async Task<HybridExchange> SendHttp(HybridRun request, CancellationToken cancellation)
	{
		var uri = new UriBuilder(address)
		{
			Scheme = "https",
			Port = -1
		}.Uri;
		var token = await provider.GetTokenAsync(uri.AbsoluteUri, TimeSpan.FromMinutes(20)).WaitAsync(cancellation);
		using var message = new HttpRequestMessage(new HttpMethod(request.Method), uri);
		var bytes = request.Bytes();
		if (request.Method is not ("GET" or "HEAD"))
			message.Content = new ByteArrayContent(bytes);
		message.Headers.TryAddWithoutValidation("ServiceBusAuthorization", token.TokenString);
		foreach (var header in request.Headers)
		{
			if (!message.Headers.TryAddWithoutValidation(header.Name, header.Value))
			{
				if (message.Content is null || !message.Content.Headers.TryAddWithoutValidation(header.Name, header.Value))
					throw HybridRunRules.Invalid();
			}
		}

		cancellation.ThrowIfCancellationRequested();
		int? status = null;
		IReadOnlyList<HybridHeader> headers = [];
		try
		{
			using var response = await http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cancellation);
			status = (int)response.StatusCode;
			headers = CaptureHeaders(response.Headers.Concat(response.Content.Headers).Select(h => new HybridHeader(h.Key, string.Join(", ", h.Value))));
			using var body = await response.Content.ReadAsStreamAsync(cancellation);
			var received = await ReadBody(body, cancellation);
			return Result(request.Method, status, status >= 400 || received.Truncated ? "rejected" : "confirmed", bytes, received.Bytes, responseTruncated: received.Truncated, requestHeaders: request.Headers, responseHeaders: headers);
		}
		catch (Exception)
		{
			return Result(request.Method, status, "unknown", bytes, [], requestHeaders: request.Headers, responseHeaders: headers);
		}
	}

	private async Task<HybridExchange> RespondHttp(RelayedHttpListenerContext context, HybridRun request, CancellationToken cancellation)
	{
		var method = context.Request.HttpMethod[..Math.Min(context.Request.HttpMethod.Length, 16)];
		var bytes = Array.Empty<byte>();
		var truncated = false;
		var response = Array.Empty<byte>();
		var status = request.ResponseStatus;
		var headers = CaptureHeaders(context.Request.Headers.AllKeys.Where(k => k is not null).Select(k => new HybridHeader(k!, context.Request.Headers[k!] ?? "")));
		try
		{
			if (context.Request.HasEntityBody)
				(bytes, truncated) = await ReadBody(context.Request.InputStream, cancellation);
			status = truncated ? 413 : request.ResponseStatus;
			context.Response.StatusCode = (HttpStatusCode)status;
			foreach (var h in request.Headers)
				context.Response.Headers[h.Name] = h.Value;
			response = method == "HEAD" || status is 204 or 304 || truncated ? [] : request.Bytes();
			await context.Response.OutputStream.WriteAsync(response, cancellation);
			responseClose = context.Response.CloseAsync();
			await responseClose.WaitAsync(cancellation);
			return Result(method, status, truncated || status >= 400 ? "rejected" : "confirmed", bytes, response, truncated, requestHeaders: headers, responseHeaders: request.Headers);
		}
		catch (Exception)
		{
			return Result(method, status, "unknown", bytes, response, truncated, requestHeaders: headers, responseHeaders: request.Headers);
		}
		finally
		{
			context.Request.InputStream?.Dispose();
		}
	}

	private async Task<HybridExchange> SendStream(HybridRun request, CancellationToken cancellation)
	{
		var client = new HybridConnectionClient(address, provider)
		{
			OperationTimeout = TimeSpan.FromSeconds(Math.Min(10, request.ExchangeSeconds))
		};
		// SDK 3.1.1 has no cancellation overload for connect. Await its bounded timeout so no late stream is orphaned.
		var stream = await client.CreateConnectionAsync();
		if (cancellation.IsCancellationRequested)
		{
			CloseStream(stream);
			cancellation.ThrowIfCancellationRequested();
		}

		return await StreamExchange(stream, request, false, cancellation);
	}

	internal async Task<HybridExchange> StreamExchange(HybridConnectionStream stream, HybridRun request, bool listening, CancellationToken cancellation)
	{
		var sent = request.Bytes();
		var received = Array.Empty<byte>();
		var truncated = false;
		try
		{
			if (listening)
			{
				(received, truncated) = await ReadBody(stream, cancellation);
				if (!truncated)
				{
					await stream.WriteAsync(sent, cancellation);
					await stream.ShutdownAsync(cancellation);
				}
				else
					sent = [];
			}
			else
			{
				await stream.WriteAsync(sent, cancellation);
				await stream.ShutdownAsync(cancellation);
				(received, truncated) = await ReadBody(stream, cancellation);
			}

			await stream.CloseAsync(cancellation);
			return Result("STREAM", null, truncated ? "rejected" : "confirmed", listening ? received : sent, listening ? sent : received, listening && truncated, !listening && truncated);
		}
		catch (Exception)
		{
			return Result("STREAM", null, "unknown", listening ? received : sent, listening ? sent : received, listening && truncated, !listening && truncated);
		}
		finally
		{
			CloseStream(stream);
		}
	}

	private void CloseStream(HybridConnectionStream stream)
	{
		try
		{
			stream.ReadTimeout = 2000;
			stream.Dispose();
		}
		catch (Exception)
		{
			cleanupFailed = true;
		}
	}

	private async Task CloseListener()
	{
		if (listener is null || closed)
			return;
		closed = true;
		try
		{
			await listener.CloseAsync(TimeSpan.FromSeconds(10));
		}
		catch
		{
			cleanupFailed = true;
			throw;
		}
	}

	public async ValueTask DisposeAsync()
	{
		requests.Writer.TryComplete();
		try
		{
			await CloseListener();
		}
		finally
		{
			while (requests.Reader.TryRead(out var pending))
			{
				try
				{
					pending.Request.InputStream?.Dispose();
				}
				catch (Exception)
				{
				}
			}

			if (responseClose is not null)
			{
				try
				{
					await responseClose.WaitAsync(TimeSpan.FromSeconds(2));
				}
				catch
				{
					cleanupFailed = true;
				}
			}

			http.Dispose();
		}

		if (cleanupFailed)
			throw new IOException("Stream cleanup was not confirmed.");
	}
}
