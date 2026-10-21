using MsgCommander.Contracts.ServiceBus.Entities;

namespace MsgCommander.Contracts.ServiceBus.Messages;

public sealed record PeekMessages(EntityTarget Target, string SubQueue, string FromSequenceNumber, int MaxMessages, bool Scheduled = false);
public sealed record ReceiveMessages(EntityTarget Target, string SubQueue, string SessionId, int MaxMessages, int WaitSeconds, string? DeferredSequence, string? SessionLeaseId);
public sealed record SettleMessage(string DeliveryId, string Action, string Reason, string Description);
public sealed record ReplayMessage(string DeliveryId, EntityTarget Destination, string IdPolicy, string MessageId);
public sealed record ResendSnapshot(string SnapshotId, EntityTarget Destination, string IdPolicy, string MessageId);
public sealed record SendMessage(EntityTarget Target, MessageDraft Draft);
public sealed record SendMessageBatch(EntityTarget Target, IReadOnlyList<MessageDraft> Drafts, string? ScheduledEnqueueTime);
public sealed record CancelScheduled(EntityTarget Target, IReadOnlyList<string> SequenceNumbers, string Confirmation);
