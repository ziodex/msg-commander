namespace MsgCommander.Contracts.EventHubs.Browsing;

public sealed record EventHubInfo(string Name, IReadOnlyList<string> PartitionIds, string CreatedAt);
public sealed record EventHubsConnection(string ConnectionId, string ProfileId, string Namespace, string ConnectedAt, bool ManagementAvailable, EventHubInfo? InitialHub, string Access = "read", string Service = "event-hubs");
public sealed record EventHubsListItem(string Name, string? Status, int? PartitionCount, string? UserMetadata);
public sealed record EventHubsPage(IReadOnlyList<EventHubsListItem> Items, string? ContinuationToken);
