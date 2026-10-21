using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Application.Relay.Gateways;
using MsgCommander.Contracts.Relay.Hybrid;
using MsgCommander.Contracts.Connections;

namespace MsgCommander.Application.Relay.Hybrid;

public sealed class HybridJobService(IHybridGatewayFactory factory) : IAsyncDisposable
{
	private bool disposed;
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	private readonly object sync = new();
	private readonly SemaphoreSlim resetGate = new(1);
	private readonly Dictionary<string, Job> jobs = [];
	private bool resetting;
	private bool cleanupUnconfirmed;
	private sealed class Job(HybridRun request)
	{
		public HybridRun Request { get; } = request;
		public CancellationTokenSource Stop { get; } = new();
		public TaskCompletionSource Done { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

		public HybridResult? Result;
	}

	public HybridResult? GetResult(string? profile, string? id)
	{
		if (!Guid.TryParse(profile, out _) || !Guid.TryParse(id, out _))
			throw HybridRunRules.Invalid();
		lock (sync)
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			return jobs.TryGetValue(id!, out var job) && job.Request.ProfileId == profile ? job.Result : null;
		}
	}

	public async Task<HybridResult> RunAsync(HybridRun request, ConnectionProfile profileValue, Func<HybridProgress, Task> emit, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		request.Validate();
		if (profileValue.Id != request.ProfileId || profileValue.Service != "relay" || !Regex.IsMatch(profileValue.Namespace ?? "", @"^[a-z0-9-]+\.servicebus\.windows\.net$", RegexOptions.IgnoreCase) || profileValue.Auth is not ("sas" or "device-code"))
			throw HybridRunRules.Invalid();
		request = request with
		{
			Headers = Array.AsReadOnly(request.Headers.ToArray())
		};
		Job state;
		lock (sync)
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			if (cleanupUnconfirmed)
				throw new OperationException(OperationFailure.ConcurrencyLimit, "Restart the backend after an unconfirmed Relay cleanup.");
			if (resetting)
				throw new OperationException(OperationFailure.ConcurrencyLimit, "Hybrid Connection jobs are resetting.");
			if (jobs.ContainsKey(request.Id))
				throw new OperationException(OperationFailure.InvalidInput, "This Hybrid Connection job ID has already been used. Recover its result; nothing was retried.");
			if (jobs.Count >= 20)
				throw new OperationException(OperationFailure.ConcurrencyLimit, "Twenty Hybrid Connection results are retained. Clear testing history before starting more jobs.");
			if (jobs.Values.Any(j => !j.Done.Task.IsCompleted && j.Request.Mode.EndsWith("listen", StringComparison.Ordinal) == request.Mode.EndsWith("listen", StringComparison.Ordinal)))
				throw new OperationException(OperationFailure.ConcurrencyLimit, "Only one Hybrid Connection sender and one listener can run at a time.");
			state = new(request);
			jobs.Add(request.Id, state);
		}

		var watch = Stopwatch.StartNew();
		var exchanges = new List<HybridExchange>();
		var bytes = 0;
		var phase = "connecting";
		var reason = "count";
		var status = "completed";
		string? cleanup = null;
		using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(request.MaxSeconds));
		using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation, state.Stop.Token, limit.Token);
		IHybridGateway? gateway = null;
		async Task Progress() => await emit(new(request.Id, exchanges.Count, request.MaxCount, Volatile.Read(ref phase), watch.Elapsed.TotalMilliseconds));
		// Progress runs on this job task; SDK callbacks only update the phase.
		using var progressStop = new CancellationTokenSource();
		async Task Pump()
		{
			try
			{
				while (true)
				{
					await Task.Delay(500, progressStop.Token);
					await Progress();
				}
			}
			catch (OperationCanceledException)
			{
			}
		}

		Task? pump = null;
		try
		{
			await Progress();
			gateway = factory.Create(profileValue, request, deviceCode, lifetime.Token);
			pump = Pump();
			await gateway.RunAsync(request, item =>
			{
				// Gateways return one exchange at a time; reserve room for the largest next item.
				if (item.RequestBody.Length > 21848 || item.ResponseBody.Length > 21848 || item.RequestHeaders.Count > 16 || item.ResponseHeaders.Count > 16)
					throw new InvalidOperationException("Invalid exchange size.");
				var value = item with
				{
					Number = exchanges.Count + 1,
					RequestHeaders = Array.AsReadOnly(item.RequestHeaders.ToArray()),
					ResponseHeaders = Array.AsReadOnly(item.ResponseHeaders.ToArray())
				};
				exchanges.Add(value);
				bytes += JsonSerializer.SerializeToUtf8Bytes(value, Json).Length;
				if (value.Outcome == "unknown")
				{
					status = "unknown";
					reason = "error";
					return false;
				}

				if (exchanges.Count >= request.MaxCount)
					return false;
				if (bytes > 450000)
				{
					status = "limited";
					reason = "buffer-limit";
					return false;
				}

				return true;
			}, value => Volatile.Write(ref phase, value), lifetime.Token);
		}
		catch (OperationCanceledException) when (lifetime.IsCancellationRequested)
		{
			reason = cancellation.IsCancellationRequested || state.Stop.IsCancellationRequested ? "cancelled" : "time";
			status = exchanges.Any(e => e.Outcome == "unknown") ? "unknown" : reason == "time" ? "limited" : "cancelled";
		}
		catch (Exception)
		{
			reason = "error";
			status = exchanges.Any(e => e.Outcome == "unknown") ? "unknown" : "failed";
		}
		finally
		{
			phase = "closing";
			try
			{
				await lifetime.CancelAsync();
			}
			catch (Exception)
			{
				cleanup = "Relay cancellation cleanup could not be confirmed. Restart the backend.";
			}

			if (gateway is not null)
			{
				try
				{
					await gateway.DisposeAsync();
				}
				catch (Exception)
				{
					cleanup = "Relay cleanup could not be confirmed. Restart the backend before starting another test.";
				}
			}

			await progressStop.CancelAsync();
			if (pump is not null)
			{
				try
				{
					await pump;
				}
				catch (Exception)
				{
				}
			}
		}

		phase = "finished";
		var summary = $"{exchanges.Count} exchange(s) retained. Stopped: {reason}. " + (status == "unknown" ? "An in-flight exchange may have reached the peer; inspect the result before sending again. " : status == "failed" ? "Check Relay Send/Listen permissions, the endpoint and connectivity. " : "") + "No payload was retried.";
		var result = new HybridResult(request.Id, request.ProfileId, profileValue.Namespace!, request.Name, request.Mode, status, reason, Array.AsReadOnly(exchanges.ToArray()), watch.Elapsed.TotalMilliseconds, summary, cleanup);
		lock (sync)
		{
			state.Result = result;
			if (cleanup is not null)
				cleanupUnconfirmed = true;
		}

		state.Done.TrySetResult();
		try
		{
			await Progress();
		}
		catch (Exception)
		{
			// The retained receipt remains recoverable.

		}

		return result;
	}

	public async Task ResetAsync()
	{
		await resetGate.WaitAsync();
		Job[] active;
		lock (sync)
		{
			resetting = true;
			active = jobs.Values.ToArray();
		}

		try
		{
			foreach (var job in active)
				await job.Stop.CancelAsync();
			await Task.WhenAll(active.Select(j => j.Done.Task)).WaitAsync(TimeSpan.FromSeconds(30));
			lock (sync)
			{
				foreach (var job in jobs.Values)
					job.Stop.Dispose();
				jobs.Clear();
			}
		}
		finally
		{
			lock (sync)
				resetting = false;
			resetGate.Release();
		}
	}

	public async ValueTask DisposeAsync()
	{
		lock (sync)
		{
			if (disposed)
				return;
			disposed = true;
		}

		await ResetAsync();
	}
}
