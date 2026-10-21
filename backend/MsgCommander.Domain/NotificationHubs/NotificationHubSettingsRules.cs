using System.Globalization;
using System.Text.RegularExpressions;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.NotificationHubs;

public static class NotificationHubSettingsRules
{
	public static void Validate(string? lifetime, IReadOnlyList<KeyValuePair<string, string>>? tags)
	{
		if (lifetime is null || lifetime.Length > 40 || !Regex.IsMatch(lifetime, @"^(?:\d{1,8}\.)?\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$") ||
			!TimeSpan.TryParseExact(lifetime, "c", CultureInfo.InvariantCulture, out var ttl) || ttl <= TimeSpan.Zero || tags is null || tags.Count > 50 ||
			tags.Any(tag => string.IsNullOrWhiteSpace(tag.Key) || tag.Key.Length > 512 || tag.Key.Any(c => char.IsControl(c) || "<>%&\\?/".Contains(c)) || tag.Value is null || tag.Value.Length > 256) ||
			tags.Select(tag => tag.Key).Distinct(StringComparer.OrdinalIgnoreCase).Count() != tags.Count)
			throw new DomainRuleException("Use a positive registration lifetime (days.hh:mm:ss), at most 50 distinct Azure tags, tag names up to 512 characters and values up to 256 characters.");
	}
}
