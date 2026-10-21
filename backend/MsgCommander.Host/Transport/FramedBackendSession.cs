using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Text.Json;

namespace MsgCommander.Host.Transport;

/// <summary>One framed protocol session owns its requests, cancellation and serialized output.</summary>
public sealed class FramedBackendSession(Stream input, Stream output,
	Func<string?, JsonElement, Func<object, Task>, CancellationToken, Task<object?>> dispatch)
{
	private const int MaxFrame = 1024 * 1024;
	private const int MaxPending = 16;
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	private readonly SemaphoreSlim outputLock = new(1);
	private readonly ConcurrentDictionary<string, CancellationTokenSource> pending = new();
	private readonly ConcurrentDictionary<string, Task> tasks = new();

	public async Task<int> RunAsync()
	{
		using var lifetime = new CancellationTokenSource();
		try
		{
			while (true)
			{
				var header = new byte[4];
				var count = await input.ReadAsync(header.AsMemory(0, 1));
				if (count == 0)
					break;
				await input.ReadExactlyAsync(header.AsMemory(1));
				var size = BinaryPrimitives.ReadUInt32BigEndian(header);
				if (size is 0 or > MaxFrame)
					return 2;
				var body = new byte[size];
				await input.ReadExactlyAsync(body);
				using var document = JsonDocument.Parse(body);
				var root = document.RootElement;
				if (root.GetProperty("jsonrpc").GetString() != "2.0")
					return 2;
				var method = root.GetProperty("method").GetString();
				var parameters = root.GetProperty("params").Clone();
				if (method == "$/cancelRequest")
				{
					if (pending.TryGetValue(parameters.GetProperty("id").GetString()!, out var cancellation))
					{
						try
						{
							await cancellation.CancelAsync();
						}
						catch (ObjectDisposedException)
						{
							// The request completed concurrently.
						}
					}
					continue;
				}
				var id = root.GetProperty("id").GetString();
				if (!Guid.TryParse(id, out _))
					return 2;
				if (pending.Count >= MaxPending)
				{
					await Error(id!, new(-32002, "Too many operations."));
					continue;
				}
				var source = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
				if (!pending.TryAdd(id!, source))
				{
					source.Dispose();
					return 2;
				}
				var task = Execute(id!, method, parameters, source);
				tasks[id!] = task;
				_ = task.ContinueWith(_ => { tasks.TryRemove(id!, out var removed); }, TaskScheduler.Default);
			}
			return 0;
		}
		catch (Exception error) when (error is JsonException or IOException or InvalidOperationException or KeyNotFoundException or ArgumentException)
		{
			await Console.Error.WriteLineAsync("Host protocol input closed or invalid.");
			return 2;
		}
		finally
		{
			await lifetime.CancelAsync();
			try
			{
				await Task.WhenAll(tasks.Values).WaitAsync(TimeSpan.FromSeconds(2));
			}
			catch (Exception)
			{
				// The parent supervises a backend that cannot drain.
			}
		}
	}

	private async Task Execute(string id, string? method, JsonElement parameters, CancellationTokenSource source)
	{
		try
		{
			var result = await dispatch(method, parameters, Event, source.Token);
			await Write(new
			{
				jsonrpc = "2.0",
				id,
				result
			});
		}
		catch (Exception error) { await Error(id, BackendProtocolErrors.Describe(error, method)); }
		finally { pending.TryRemove(id, out _); source.Dispose(); }
	}

	private Task Event(object value) => Write(new { jsonrpc = "2.0", method = "event", @params = value });
	private Task Error(string id, BackendProtocolError error) => Write(new { jsonrpc = "2.0", id, error = new { code = error.Code, message = error.Message } });
	private async Task Write(object value)
	{
		var body = JsonSerializer.SerializeToUtf8Bytes(value, Json);
		if (body.Length > MaxFrame)
			throw new InvalidOperationException("Output exceeds limit.");
		var header = new byte[4];
		BinaryPrimitives.WriteUInt32BigEndian(header, (uint)body.Length);
		await outputLock.WaitAsync();
		try
		{
			await output.WriteAsync(header);
			await output.WriteAsync(body);
			await output.FlushAsync();
		}
		finally { outputLock.Release(); }
	}
}
