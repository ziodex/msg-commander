namespace MsgCommander.Contracts.ServiceBus.Messages;

public sealed record DeferredReferenceInfo(string SequenceNumber, string RecordedAt);
public sealed record DeferredReferences(int Total, IReadOnlyList<DeferredReferenceInfo> Items);
