using System.Text.Json.Serialization;
using MsgCommander.Contracts.Common;

namespace MsgCommander.Contracts.ServiceBus.Entities;

public sealed record EntityTarget(string Kind, string Name,
	[property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? TopicName = null);
public sealed record EntityInfo(EntityTarget Target, string Status, bool? RequiresSession);
public sealed record EntityPage(IReadOnlyList<EntityInfo> Items, string? ContinuationToken);
public sealed record EntityCounts(string? Active = null, string? DeadLetter = null, string? Scheduled = null,
	string? Transfer = null, string? TransferDeadLetter = null, string? Total = null, string? SizeBytes = null);
public sealed record EntityDetails(EntityInfo Entity, IReadOnlyList<PropertyValue> Properties,
	EntityCounts Counts, string? CountsWarning, string FetchedAt);
