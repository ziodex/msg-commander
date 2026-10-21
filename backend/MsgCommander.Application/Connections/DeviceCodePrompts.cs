using MsgCommander.Application.Common;
using MsgCommander.Contracts.Connections;

namespace MsgCommander.Application.Connections;

/// <summary>Routes an authentication prompt to its live logical request, including SDK continuations.</summary>
public sealed class DeviceCodePrompts
{
	private readonly AsyncLocal<Binding?> active = new();
	private int closed;
	private sealed class Binding(Func<DeviceCodeEvent, Task>? forward, CancellationToken cancellation)
	{
		public readonly object Sync = new();
		public Func<DeviceCodeEvent, Task>? Forward = forward;
		public CancellationToken Cancellation = cancellation;
		public bool Closed;
	}
	private sealed class Scope(DeviceCodePrompts owner, Binding binding, Binding? previous) : IDisposable
	{
		private int disposed;
		public void Dispose()
		{
			if (Interlocked.Exchange(ref disposed, 1) != 0)
				return;
			lock (binding.Sync)
			{
				binding.Closed = true;
				binding.Forward = null;
			}
			owner.active.Value = previous;
		}
	}
	public IDisposable Enter(Func<DeviceCodeEvent, Task>? forward, CancellationToken cancellation)
	{
		if (Volatile.Read(ref closed) != 0)
			throw Expired();
		var previous = active.Value;
		var binding = new Binding(forward, cancellation);
		active.Value = binding;
		return new Scope(this, binding, previous);
	}
	public Task ForwardAsync(DeviceCodeEvent code)
	{
		if (Volatile.Read(ref closed) != 0)
			throw Expired();
		var binding = active.Value;
		if (binding is null)
			throw Expired();
		lock (binding.Sync)
		{
			if (binding.Closed || binding.Forward is not { } forward)
				throw Expired();
			binding.Cancellation.ThrowIfCancellationRequested();
			return forward(code);
		}
	}
	public void Close() => Interlocked.Exchange(ref closed, 1);
	private static OperationException Expired() => new(OperationFailure.AuthenticationRequired, "Reconnect to the namespace to sign in again.");
}
