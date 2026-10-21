using System.Globalization;
using MsgCommander.Contracts.Common;

namespace MsgCommander.Application.Common;

public static class DisplayValues
{
	public static string Number(long value) => value.ToString(CultureInfo.InvariantCulture);
	public static string Timestamp(DateTimeOffset value) => value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
	public static PropertyValue Property(string name, object? value) => value switch
	{
		null => new(name, "null", "null"),
		string text => new(name, "string", text),
		bool boolean => new(name, "boolean", boolean ? "true" : "false"),
		byte[] bytes => new(name, "binary", Convert.ToBase64String(bytes)),
		ReadOnlyMemory<byte> bytes => new(name, "binary", Convert.ToBase64String(bytes.Span)),
		ArraySegment<byte> bytes => new(name, "binary", Convert.ToBase64String(bytes.AsSpan())),
		DateTimeOffset time => new(name, "datetime-offset", time.ToString("O", CultureInfo.InvariantCulture)),
		DateTime time => new(name, "datetime", time.ToString("O", CultureInfo.InvariantCulture)),
		TimeSpan duration => new(name, "timespan", duration.ToString("c", CultureInfo.InvariantCulture)),
		Guid guid => new(name, "guid", guid.ToString()),
		Uri uri => new(name, "uri", uri.OriginalString),
		byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal => new(name, value.GetType().Name.ToLowerInvariant(), ((IFormattable)value).ToString(null, CultureInfo.InvariantCulture)),
		_ => new(name, $"unsupported:{value.GetType().Name}", "This AMQP property type is not supported by the inspector.")
	};
}
