using MsgCommander.Application.ServiceBus.Messages;
namespace MsgCommander.Infrastructure.ServiceBus.Messages;

public sealed class InMemoryMessageDeferProvider(int capacity = 10000) : IMessageDeferProvider
{
	private readonly object sync = new();
	private readonly int limit = capacity is > 0 and <= 10000 ? capacity : throw new ArgumentOutOfRangeException(nameof(capacity));
	private readonly Dictionary<DeferredMessageScope, List<DeferredMessageReference>> scopes = [];
	private int count;
	public void Remember(DeferredMessageScope scope, DeferredMessageReference reference)
	{
		lock (sync)
		{
			if (reference.Sequence < 0)
				throw new ArgumentOutOfRangeException(nameof(reference));
			scopes.TryGetValue(scope, out var entries);
			if (entries?.Any(entry => entry.Sequence == reference.Sequence) == true)
				return;
			if (count >= limit)
				throw new InvalidOperationException("Deferred reference limit reached.");
			if (entries is null)
				scopes.Add(scope, entries = []);
			entries.Add(reference);
			count++;
		}
	}
	public IReadOnlyList<DeferredMessageReference> List(DeferredMessageScope scope)
	{
		lock (sync)
			return scopes.TryGetValue(scope, out var entries) ? entries.ToArray() : [];
	}
	public bool Forget(DeferredMessageScope scope, long sequence)
	{
		lock (sync)
		{
			if (!scopes.TryGetValue(scope, out var entries))
				return false;
			var removed = entries.RemoveAll(entry => entry.Sequence == sequence);
			count -= removed;
			if (entries.Count == 0)
				scopes.Remove(scope);
			return removed > 0;
		}
	}
}
