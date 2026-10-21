using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Sessions;

namespace MsgCommander.Contracts.ServiceBus.Messages;

public sealed record MessageDraft(string BodyBase64, string MessageId, string Subject, string ContentType, string CorrelationId, string SessionId, string ReplyTo, string ReplyToSessionId, string To, string PartitionKey, int? TtlSeconds, IReadOnlyList<PropertyValue> Properties, string? TtlDuration = null);
public sealed record OperationOutcome(string OperationId, string Status, string Summary, string? MessageId, [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? SequenceNumbers = null);
public sealed record DeliveryInfo(string DeliveryId, MessageSummary Summary, string LockedUntil, string State);
public sealed record Deliveries(EntityTarget? Target, string SubQueue, string? SessionId, IReadOnlyList<DeliveryInfo> Items, string? Warning, SessionLease? Session = null);
