using System.Text;
using System.Threading.Channels;
using MsgCommander.Host;

sealed class FixtureHybridFactory : IHybridGatewayFactory
{
	private readonly Dictionary<string, Channel<Call>> listeners = [];
	internal sealed record Call(HybridRun Request, TaskCompletionSource<HybridExchange> Response);
	public IHybridGateway Create(ConnectionProfile profile, HybridRun request, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		if (profile.Namespace != "fixture.servicebus.windows.net")
			throw new InvalidOperationException("Fixture namespace only.");
		if (request.Name == "denied")
			throw new UnauthorizedAccessException("SECRET should never leave host");
		return new Gateway(this);
	}

	private sealed class Gateway(FixtureHybridFactory owner) : IHybridGateway
	{
		private string? key;
		public async Task RunAsync(HybridRun request, Func<HybridExchange, bool> record, Action<string> phase, CancellationToken cancellation)
		{
			var scope = request.Name + ":" + request.Mode.Split('-')[0];
			if (request.Mode.EndsWith("listen", StringComparison.Ordinal))
			{
				var channel = Channel.CreateBounded<Call>(1);
				lock (owner.listeners)
					owner.listeners.Add(scope, channel);
				key = scope;
				phase("online");
				while (true)
				{
					var call = await channel.Reader.ReadAsync(cancellation);
					var value = Exchange(call.Request, request.Bytes());
					call.Response.TrySetResult(value);
					if (!record(value))
						break;
				}
			}
			else
			{
				phase("exchanging");
				for (var i = 0; i < request.MaxCount; i++)
				{
					cancellation.ThrowIfCancellationRequested();
					await Task.Delay(20, cancellation);
					HybridExchange result;
					Channel<Call>? channel;
					lock (owner.listeners)
						owner.listeners.TryGetValue(scope, out channel);
					if (request.Name == "unknown")
						result = Exchange(request, []) with
						{
							Outcome = "unknown",
							Summary = "Interrupted after dispatch. No retry."
						};
					else if (request.Name == "slow")
					{
						await Task.Delay(Timeout.Infinite, cancellation);
						throw new InvalidOperationException();
					}
					else if (channel is not null)
					{
						var completion = new TaskCompletionSource<HybridExchange>(TaskCreationOptions.RunContinuationsAsynchronously);
						await channel.Writer.WriteAsync(new(request, completion), cancellation);
						result = await completion.Task.WaitAsync(cancellation);
					}
					else
						result = Exchange(request, request.Name == "large" ? new byte[HybridRunRules.BodyLimit] : Encoding.UTF8.GetBytes("{\"reply\":\"offline relay\",\"count\":9007199254740993}"));
					if (!record(result))
						break;
				}
			}
		}

		private static HybridExchange Exchange(HybridRun request, byte[] response) => new(1, DateTimeOffset.UtcNow.ToString("O"), request.Mode.StartsWith("stream", StringComparison.Ordinal) ? "STREAM" : request.Method, request.Mode.StartsWith("stream", StringComparison.Ordinal) ? null : 200, "confirmed", Convert.ToBase64String(request.Bytes()), Convert.ToBase64String(response), false, false, request.Headers, [new("Content-Type", "application/json")], "Exchange completed.");
		public ValueTask DisposeAsync()
		{
			if (key is not null)
				lock (owner.listeners)
				{
					if (owner.listeners.Remove(key, out var channel))
						channel.Writer.TryComplete();
				}

			return ValueTask.CompletedTask;
		}
	}
}
