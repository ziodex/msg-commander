using MsgCommander.Contracts.Common;

namespace MsgCommander.Contracts.EventGrid.Browsing;

public sealed record EventGridManagement(string ResourceId, string TenantId, string ClientId);
public sealed record EventGridTarget(string Kind, string? TopicName, string? SubscriptionName);
public sealed record EventGridConnection(string ConnectionId, string ProfileId, string Namespace, string ResourceId, string Location, string ConnectedAt);
public sealed record EventGridItem(EventGridTarget Target, string Name, string? ProvisioningState, string? DeliveryMode, string? InputSchema);
public sealed record EventGridPage(IReadOnlyList<EventGridItem> Items, string? ContinuationToken);
public sealed record EventGridFilter(string? Key, string? OperatorType, bool Known, string DefinitionJson);
public sealed record EventGridFilters(IReadOnlyList<string>? IncludedEventTypes, IReadOnlyList<EventGridFilter> Filters);
public sealed record EventGridDetails(EventGridTarget Target, string ResourceId, string Name, IReadOnlyList<PropertyValue> Properties, EventGridFilters? Filters, string? DeliveryJson, string? Warning, string CapturedAt);
