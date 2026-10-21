using MsgCommander.Contracts.EventGrid.Browsing;

namespace MsgCommander.Contracts.EventGrid.Administration;

public sealed record EventGridAdminFilter(string Key, string OperatorType, string OperandJson);
public sealed record EventGridSubscriptionSettings(string DeliveryMode, int? ReceiveLockDurationInSeconds, int? MaxDeliveryCount, string? EventTimeToLive, string? ExpirationTimeUtc, IReadOnlyList<string>? IncludedEventTypes, IReadOnlyList<EventGridAdminFilter>? Filters);
public sealed record EventGridDestination(string EndpointType, string? EndpointUrl, string? ResourceId, string? QueueName);
public sealed record EventGridAdminDetails(EventGridTarget Target, string Revision, int? RetentionDays, EventGridSubscriptionSettings? Settings, string? Warning, EventGridDeliveryDetails? Delivery = null);
public sealed record EventGridAdminChange(string Id, string ConnectionId, EventGridTarget Target, string Action, string? ExpectedRevision, int? RetentionDays, EventGridSubscriptionSettings? Settings, EventGridDestination? Destination, bool Acknowledged, string? Confirmation, EventGridDelivery? Delivery = null);
public sealed record EventGridAdminOutcome(string OperationId, EventGridTarget Target, string Action, string Status, string Summary);
public sealed record EventGridIdentity(string Type, string? UserAssignedIdentity);
public sealed record EventGridHeader(string Name, string Type, string? Value = null, bool? IsSecret = null, string? SourceField = null);
public sealed record EventGridDeadLetterChange(string Action, string? ResourceId, string? ContainerName, EventGridIdentity? Identity);
public sealed record EventGridWebhookAuthentication(string TenantId, string ApplicationIdOrUri);
public sealed record EventGridDelivery(EventGridIdentity? Identity, IReadOnlyList<EventGridHeader>? Headers, EventGridDeadLetterChange? DeadLetter, EventGridWebhookAuthentication? WebhookAuthentication = null);
public sealed record EventGridHeaderDetails(string Name, string Type, bool IsSecret);
public sealed record EventGridDeadLetterDetails(string? ResourceId, string? ContainerName, EventGridIdentity? Identity);
public sealed record EventGridDeliveryDetails(string? DestinationType, string? ResourceId, EventGridIdentity? Identity, IReadOnlyList<EventGridHeaderDetails> Headers, EventGridDeadLetterDetails? DeadLetter);
