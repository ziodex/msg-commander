using MsgCommander.Domain.Connections;

namespace MsgCommander.Application.Connections;

public sealed record ReceiverAddress<TTarget>(TTarget Target, string SubQueue, string? SessionId);

/// <summary>Owns an interactive receiver under its connection's operation gate.</summary>
public sealed class ReceiverOwner<TReceiver, TTarget>(Action clearState) : IAsyncDisposable
	where TReceiver : class, IAsyncDisposable
{
	private readonly SemaphoreSlim gate = new(1);
	public TReceiver? Current
	{
		get; private set;
	}
	public ReceiverAddress<TTarget>? Address
	{
		get; private set;
	}
	public string? OwnershipId
	{
		get; private set;
	}

	public async Task OpenAsync(ReceiverAddress<TTarget> address,
		Func<CancellationToken, Task<TReceiver>> open, CancellationToken cancellation)
	{
		await gate.WaitAsync(cancellation);
		try
		{
			if (Current is not null)
				throw new InvalidOperationException("Release the current receiver before opening another.");
			cancellation.ThrowIfCancellationRequested();
			var candidate = await open(cancellation);
			try
			{
				cancellation.ThrowIfCancellationRequested();
				Current = candidate;
				Address = address;
				OwnershipId = ConnectionIdentity.Create().Value;
			}
			catch
			{
				await candidate.DisposeAsync();
				throw;
			}
		}
		finally { gate.Release(); }
	}

	public async ValueTask DisposeAsync()
	{
		await gate.WaitAsync();
		try
		{
			var previous = Current;
			Current = null;
			Address = null;
			OwnershipId = null;
			try
			{
				clearState();
			}
			finally { if (previous is not null) await previous.DisposeAsync(); }
		}
		finally { gate.Release(); }
	}
}
