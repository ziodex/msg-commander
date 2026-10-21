using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Messages;

namespace MsgCommander.Contracts.ServiceBus.Listeners;

public sealed record ListenerItem(string DeliveryId, MessageSummary Summary, string State, string LockedUntil, string ReceivedAt);
public sealed record ListenerState(string ListenerId, string ConnectionId, EntityTarget Target, string? SessionId, string Mode, string Status,
	int Received, int Completed, int Abandoned, int DeadLettered, int Deferred, int Failed, int Uncertain, int Renewed,
	long ElapsedMs, int MaxMessages, int MaxSeconds, int MaxLockSeconds, int RetainedBytes, int Evicted, string Summary, IReadOnlyList<ListenerItem> Items,
	string SessionMode, int MaxConcurrentSessions, int SessionIdleSeconds, int ActiveSessions, int AcceptingSessions,
	int SessionAcquisitions, int SessionHistoryEvicted, IReadOnlyList<ListenerSession> Sessions);
public sealed record ListenerSession(string SessionId, string Status, int Received, int Completed, int Abandoned, int DeadLettered,
	int Deferred, int Failed, int Uncertain, int Renewed, int Pending, string? LockedUntil, string Summary);

public sealed record ListenerSettlement(string Id, string DeliveryId, string Action, string Reason, string Description);
public sealed record ListenerStart(string Id, EntityTarget Target, string Mode, string SessionId,
	int MaxMessages, int MaxSeconds, int MaxLockSeconds, string SessionMode, int MaxConcurrentSessions, int SessionIdleSeconds);
