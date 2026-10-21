using System.Text.RegularExpressions;
using System.Xml;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.EventGrid;

public static class EventGridRetention
{
	public static TimeSpan? TimeToLive(string? value)
	{
		if (value is null)
			return null;
		try
		{
			if (value.Length > 64 || !Regex.IsMatch(value, @"^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$"))
				throw new FormatException();
			var ttl = XmlConvert.ToTimeSpan(value);
			if (ttl < TimeSpan.FromMinutes(1) || ttl > TimeSpan.FromDays(7))
				throw new FormatException();
			return ttl;
		}
		catch (Exception error) when (error is FormatException or OverflowException)
		{
			throw new DomainRuleException("Event TTL must be an ISO 8601 day/time duration between PT1M and P7D, no longer than topic retention.");
		}
	}
}
