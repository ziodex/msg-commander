using System.Globalization;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.ServiceBus.Messages;

public static class PurgeCutoff
{
	public static DateTimeOffset Parse(string? value)
	{
		if (!DateTimeOffset.TryParseExact(value, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture,
			DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var cutoff))
			throw new DomainRuleException("Use an explicit UTC purge cutoff in yyyy-MM-ddTHH:mm:ss.fffZ format, or omit the cutoff.");
		return cutoff;
	}
	public static string Format(DateTimeOffset value) => value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
	public static bool Includes(DateTimeOffset cutoff, DateTimeOffset enqueuedTime) => enqueuedTime < cutoff;
}
