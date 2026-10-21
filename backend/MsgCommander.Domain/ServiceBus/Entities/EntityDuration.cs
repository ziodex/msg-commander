using System.Globalization;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.ServiceBus.Entities;

public static class EntityDuration
{
	public static TimeSpan Parse(string? value, string? unlimited = null)
	{
		if (unlimited is not null && value == unlimited)
			return TimeSpan.MaxValue;
		if (value is null || value.Length > 40 ||
			!TimeSpan.TryParseExact(value, "c", CultureInfo.InvariantCulture, out var result) || result <= TimeSpan.Zero)
			throw new DomainRuleException("Use positive durations as [days.]hh:mm:ss[.fffffff], 'unlimited' for TTL or 'disabled' for auto-delete.");
		return result;
	}

	public static string Format(TimeSpan value, string? unlimited = null) =>
		value == TimeSpan.MaxValue && unlimited is not null ? unlimited : value.ToString("c", CultureInfo.InvariantCulture);
}
