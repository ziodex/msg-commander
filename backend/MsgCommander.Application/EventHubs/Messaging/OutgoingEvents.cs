using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.EventHubs.Messaging;
namespace MsgCommander.Application.EventHubs.Messaging;

public static class OutgoingEvents
{
	public static OutgoingEvent Build(EventDraft draft, string id)
	{
		if (draft.BodyBase64 is null || draft.BodyBase64.Length > 349528 || !Regex.IsMatch(draft.BodyBase64, @"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$") ||
			draft.ContentType is null || draft.ContentType.Length > 128 || draft.CorrelationId is null || draft.CorrelationId.Length > 128 ||
			draft.Properties is null || draft.Properties.Count > 32 || JsonSerializer.SerializeToUtf8Bytes(draft.Properties).Length > 65536)
			throw new OperationException(OperationFailure.InvalidInput, "Use valid base64, 128-character fields, at most 32 properties and 64 KiB of metadata.");
		var bytes = Convert.FromBase64String(draft.BodyBase64);
		if (bytes.Length > 262144)
			throw new OperationException(OperationFailure.InvalidInput, "The event body limit is 256 KiB; broker batch limits also include metadata.");
		var data = new OutgoingEvent(EventBody.FromBytes(bytes), id);
		if (draft.ContentType.Length > 0)
			data.ContentType = draft.ContentType;
		if (draft.CorrelationId.Length > 0)
			data.CorrelationId = draft.CorrelationId;
		foreach (var p in draft.Properties)
		{
			if (string.IsNullOrWhiteSpace(p.Name) || p.Name.Length > 128 || p.Value is null || p.Value.Length > 4096 || data.Properties.ContainsKey(p.Name))
				throw new OperationException(OperationFailure.InvalidInput, "Use unique property names up to 128 characters and values up to 4096 characters.");
			try
			{
				var culture = CultureInfo.InvariantCulture;
				object value = p.Type switch
				{
					"string" => p.Value,
					"boolean" => p.Value switch { "true" => true, "false" => false, _ => throw new FormatException() },
					"int32" => int.Parse(p.Value, NumberStyles.AllowLeadingSign, culture),
					"int64" => long.Parse(p.Value, NumberStyles.AllowLeadingSign, culture),
					"uint64" => ulong.Parse(p.Value, NumberStyles.None, culture),
					"double" => double.TryParse(p.Value, NumberStyles.Float, culture, out var n) && double.IsFinite(n) ? n : throw new FormatException(),
					"guid" => Guid.Parse(p.Value),
					"datetime" => Regex.IsMatch(p.Value, @"(Z|[+-]\d{2}:\d{2})$") ? DateTimeOffset.ParseExact(p.Value, ["yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK"], culture, DateTimeStyles.None).UtcDateTime : throw new FormatException(),
					"binary" => Regex.IsMatch(p.Value, @"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$") ? Convert.FromBase64String(p.Value) : throw new FormatException(),
					_ => throw new FormatException()
				};
				data.Properties.Add(p.Name, value);
			}
			catch (Exception error) when (error is FormatException or OverflowException)
			{
				throw new OperationException(OperationFailure.InvalidInput, "An event property has an invalid value for its declared type.");
			}
		}
		return data;
	}
}
