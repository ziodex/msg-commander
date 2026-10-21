using System.Collections.Frozen;
namespace MsgCommander.Domain.EventGrid;

public static class AdvancedFilterOperators
{
	public static IReadOnlySet<string> Supported { get; } = ((string[])["BoolEquals", "IsNotNull", "IsNullOrUndefined", "NumberGreaterThan", "NumberGreaterThanOrEquals", "NumberIn", "NumberInRange", "NumberLessThan", "NumberLessThanOrEquals", "NumberNotIn", "NumberNotInRange", "StringBeginsWith", "StringContains", "StringEndsWith", "StringIn", "StringNotBeginsWith", "StringNotContains", "StringNotEndsWith", "StringNotIn"]).ToFrozenSet(StringComparer.Ordinal);
}
