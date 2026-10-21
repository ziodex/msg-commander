using System.Diagnostics;
using MsgCommander.Contracts.EventHubs.Messaging;

namespace MsgCommander.Application.EventHubs.Messaging;
// Statistics belong to one operation. Concurrent partition workers share this bounded accumulator.
public sealed class EventStatisticsCounter
{
	private readonly object sync = new();
	private long calls, failures, empty, events, bytes;
	private double totalMs;
	private double? minMs, maxMs;
	private int? minBytes, maxBytes;
	public void Call(double milliseconds, bool succeeded, bool isEmpty = false)
	{
		lock (sync)
		{
			if (!succeeded)
			{
				failures++;
				return;
			}
			calls++;
			if (isEmpty)
				empty++;
			totalMs += milliseconds;
			minMs = minMs is null ? milliseconds : Math.Min(minMs.Value, milliseconds);
			maxMs = maxMs is null ? milliseconds : Math.Max(maxMs.Value, milliseconds);
		}
	}
	public void Body(int size)
	{
		lock (sync)
		{
			events++;
			bytes += size;
			minBytes = minBytes is null ? size : Math.Min(minBytes.Value, size);
			maxBytes = maxBytes is null ? size : Math.Max(maxBytes.Value, size);
		}
	}
	public EventOperationStatistics Snapshot()
	{
		lock (sync)
			return new(calls, failures, empty, totalMs, minMs, maxMs, events, bytes, minBytes, maxBytes);
	}
	public async Task<T> Measure<T>(Func<Task<T>> action, Func<T, bool>? isEmpty = null)
	{
		var started = Stopwatch.GetTimestamp();
		try
		{
			var value = await action();
			Call(Stopwatch.GetElapsedTime(started).TotalMilliseconds, true, isEmpty?.Invoke(value) == true);
			return value;
		}
		catch { Call(Stopwatch.GetElapsedTime(started).TotalMilliseconds, false); throw; }
	}
}
