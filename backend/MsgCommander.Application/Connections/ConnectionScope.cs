using MsgCommander.Domain.Connections;

namespace MsgCommander.Application.Connections;

public sealed class ConnectionExpiredException(string message) : Exception(message);

/// <summary>Owns one client and serializes its operations, replacement and disposal.</summary>
public sealed class ConnectionScope<TClient, TConnection>(Func<ValueTask> clearState,
	Func<TConnection, string> identity, string expiredMessage) : IAsyncDisposable
	where TClient : class, IAsyncDisposable
	where TConnection : class
{
	private readonly SemaphoreSlim gate = new(1);
	private TClient? client;
	private TConnection? connection;
	private ConnectionIdentity generation;
	private bool disposed;

	public TClient? Client => Volatile.Read(ref client);
	public TConnection? Connection => Volatile.Read(ref connection);

	public async Task<TConnection> ConnectAsync(Func<CancellationToken, Task<TClient>> connect,
		Func<string, TClient, TConnection> describe, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			// Drain dependent receivers before releasing the old client and authenticating another.
			await ClearAsync();
			var candidate = await connect(cancellation);
			try
			{
				cancellation.ThrowIfCancellationRequested();
				var nextGeneration = ConnectionIdentity.Create();
				var snapshot = describe(nextGeneration.Value, candidate);
				if (!nextGeneration.Matches(identity(snapshot)))
					throw new InvalidOperationException("The connection metadata must identify its owned client generation.");
				client = candidate;
				connection = snapshot;
				generation = nextGeneration;
				return snapshot;
			}
			catch
			{
				await candidate.DisposeAsync();
				throw;
			}
		}
		finally { gate.Release(); }
	}

	public async Task<T> ExecuteAsync<T>(string? connectionId, Func<TClient, CancellationToken, Task<T>> action,
		CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			if (client is null || connection is null || !generation.Matches(connectionId))
				throw new ConnectionExpiredException(expiredMessage);
			return await action(client, cancellation);
		}
		finally { gate.Release(); }
	}

	public async Task DisconnectAsync(string? connectionId, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			if (connection is not null && generation.Matches(connectionId))
				await ClearAsync();
		}
		finally { gate.Release(); }
	}

	public async Task ResetAsync(CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			ObjectDisposedException.ThrowIf(disposed, this);
			await ClearAsync();
		}
		finally { gate.Release(); }
	}

	private async ValueTask ClearAsync()
	{
		var previous = client;
		try
		{
			await clearState();
		}
		finally
		{
			client = null;
			connection = null;
			generation = default;
			if (previous is not null)
				await previous.DisposeAsync();
		}
	}

	public async ValueTask DisposeAsync()
	{
		await gate.WaitAsync();
		try
		{
			if (disposed)
				return;
			disposed = true;
			await ClearAsync();
		}
		finally { gate.Release(); }
	}
}
