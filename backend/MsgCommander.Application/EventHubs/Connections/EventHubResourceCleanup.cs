namespace MsgCommander.Application.EventHubs.Connections;

/// <summary>Retains failed endpoints for an explicit cleanup retry before reconnect.</summary>
public sealed class EventHubResourceCleanup
{
	private readonly object sync = new();
	private readonly HashSet<IAsyncDisposable> pending = new(ReferenceEqualityComparer.Instance);
	public bool HasFailures
	{
		get
		{
			lock (sync)
				return pending.Count != 0;
		}
	}
	public async Task<bool> CloseAsync(IAsyncDisposable value)
	{
		try
		{
			await value.DisposeAsync();
			lock (sync)
				pending.Remove(value);
			return true;
		}
		catch { lock (sync) pending.Add(value); return false; }
	}
	public async Task RetryAsync()
	{
		IAsyncDisposable[] values;
		lock (sync)
			values = pending.ToArray();
		foreach (var value in values)
			await CloseAsync(value);
	}
}
