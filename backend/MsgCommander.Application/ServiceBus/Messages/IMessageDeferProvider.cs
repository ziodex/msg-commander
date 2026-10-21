using MsgCommander.Contracts.ServiceBus.Entities;
namespace MsgCommander.Application.ServiceBus.Messages;

public sealed record DeferredMessageScope(string ProfileId, string Namespace, EntityTarget Target, string SubQueue, string SessionId);
public sealed record DeferredMessageReference(long Sequence, DateTimeOffset RecordedAt);

// Implementations must be thread-safe. Remove references only after a confirmed retrieval.
public interface IMessageDeferProvider
{
	void Remember(DeferredMessageScope scope, DeferredMessageReference reference);
	IReadOnlyList<DeferredMessageReference> List(DeferredMessageScope scope);
	bool Forget(DeferredMessageScope scope, long sequence);
}
