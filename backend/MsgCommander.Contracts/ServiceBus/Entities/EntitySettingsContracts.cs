namespace MsgCommander.Contracts.ServiceBus.Entities;

public sealed record EntitySettings(
	string Status, string DefaultMessageTimeToLive, string AutoDeleteOnIdle, bool EnableBatchedOperations, string UserMetadata,
	string? LockDuration, int? MaxDeliveryCount, bool? DeadLetteringOnMessageExpiration, string? ForwardTo, string? ForwardDeadLetteredMessagesTo, bool? RequiresSession,
	long? MaxSizeInMegabytes, long? MaxMessageSizeInKilobytes, bool? RequiresDuplicateDetection, string? DuplicateDetectionHistoryTimeWindow, bool? EnablePartitioning,
	bool? SupportOrdering, bool? EnableDeadLetteringOnFilterEvaluationExceptions);
public sealed record EntityConfiguration(EntityTarget Target, EntitySettings Settings, string Revision);
