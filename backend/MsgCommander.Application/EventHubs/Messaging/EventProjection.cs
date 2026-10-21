using System.Text.Json;
using MsgCommander.Contracts.Common;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Application.EventHubs.Messaging;

public static class EventProjection
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	public static string? Clip(string? value) => value is { Length: > 256 } ? value[..256] : value;
	public static IReadOnlyList<PropertyValue> Properties(IEnumerable<KeyValuePair<string, object>> values, out bool warning)
	{
		warning = false;
		List<PropertyValue> result = [];
		var used = 0;
		foreach (var item in values)
		{
			if (result.Count == 64)
			{
				warning = true;
				break;
			}
			var projected = Property(item.Key, item.Value);
			if (projected.Name.Length > 256 || projected.Value.Length > 2048)
			{
				warning = true;
				projected = projected with
				{
					Name = projected.Name[..Math.Min(256, projected.Name.Length)],
					Value = projected.Value[..Math.Min(2048, projected.Value.Length)]
				};
			}
			used += JsonSerializer.SerializeToUtf8Bytes(projected, Json).Length;
			if (used > 32768)
			{
				warning = true;
				break;
			}
			result.Add(projected);
		}
		return result;
	}
}
