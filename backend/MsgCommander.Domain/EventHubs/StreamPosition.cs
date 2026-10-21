using System.Globalization;
using System.Text.RegularExpressions;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.EventHubs;

public enum StreamPositionKind
{
	Earliest, Latest, Time, Sequence, Offset
}
public sealed record StreamPosition
{
	public StreamPositionKind Kind
	{
		get;
	}
	public string? Value
	{
		get;
	}
	public bool Inclusive
	{
		get;
	}
	private StreamPosition(StreamPositionKind kind, string? value = null, bool inclusive = false)
	{
		Kind = kind;
		Value = value;
		Inclusive = inclusive;
	}
	public static StreamPosition Create(string kind, string? value = null, bool? inclusive = null)
	{
		if (kind is "earliest" or "latest" && value is null && inclusive is null)
			return new(kind == "earliest" ? StreamPositionKind.Earliest : StreamPositionKind.Latest);
		if (kind == "time" && inclusive is null && value is not null && Regex.IsMatch(value, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$") &&
			DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.None, out var time) && time.Year > 1)
			return new(StreamPositionKind.Time, value);
		if (kind == "sequence" && inclusive is not null && value is not null && Regex.IsMatch(value, @"^(0|[1-9][0-9]{0,18})$") && long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out _))
			return new(StreamPositionKind.Sequence, value, inclusive.Value);
		if (kind == "offset" && inclusive is not null && value is { Length: > 0 and <= 256 } && !Regex.IsMatch(value, @"[\s\x00-\x1f]"))
			return new(StreamPositionKind.Offset, value, inclusive.Value);
		throw new DomainRuleException("Choose earliest/latest, an exact sequence or offset, or an ISO date/time with timezone.");
	}
}
