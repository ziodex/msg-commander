namespace MsgCommander.Application.Common;

/// <summary>Connection-owned bounded results. The owning operation gate serializes callers.</summary>
public sealed class OperationReceipts<T>(int capacity, string conflictMessage, string capacityMessage) where T : class
{
	private readonly Dictionary<string, (string Fingerprint, T Result)> entries = [];
	public IEnumerable<T> Results => entries.Values.Select(entry => entry.Result);
	public T? Get(string id) => entries.TryGetValue(id, out var entry) ? entry.Result : null;
	public T? CheckRequest(string id, string fingerprint)
	{
		if (!Guid.TryParse(id, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid operation ID.");
		if (entries.TryGetValue(id, out var existing))
		{
			if (existing.Fingerprint != fingerprint)
				throw new OperationException(OperationFailure.InvalidInput, conflictMessage);
			return existing.Result;
		}
		if (entries.Count >= capacity)
			throw new OperationException(OperationFailure.OperationBlocked, capacityMessage);
		return null;
	}
	public void Add(string id, string fingerprint, T result) => entries.Add(id, (fingerprint, result));
	public void Clear() => entries.Clear();
}
