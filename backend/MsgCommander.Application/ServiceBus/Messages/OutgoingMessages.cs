using System.Globalization;
using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Messages;

namespace MsgCommander.Application.ServiceBus.Messages;

public static class OutgoingMessages
{
	private static readonly CultureInfo Culture = CultureInfo.InvariantCulture;
	public static void ValidateDestination(EntityTarget target)
	{
		target.Validate();
		if (target.Kind == "subscription")
			throw new OperationException(OperationFailure.InvalidInput, "Send to a queue or topic, not a subscription.");
	}
	public static OutgoingMessage Build(MessageDraft draft)
	{
		if (draft.Properties.Count > 32 || JsonSerializer.SerializeToUtf8Bytes(draft.Properties).Length > 65536)
			throw new OperationException(OperationFailure.InvalidInput, "Use at most 32 properties and 64 KiB of property metadata.");
		Check(draft.MessageId, 128, true);
		Check(draft.Subject, 128);
		Check(draft.ContentType, 128);
		Check(draft.CorrelationId, 128);
		Check(draft.SessionId, 128);
		Check(draft.ReplyTo, 260);
		Check(draft.ReplyToSessionId, 128);
		Check(draft.To, 260);
		Check(draft.PartitionKey, 128);
		if (draft.TtlSeconds is < 1 or > 31536000)
			throw new OperationException(OperationFailure.InvalidInput, "TTL must be 1–31536000 seconds or empty for the entity default.");
		byte[] bytes;
		try
		{
			bytes = Convert.FromBase64String(draft.BodyBase64);
		}
		catch (FormatException) { throw new OperationException(OperationFailure.InvalidInput, "Body must be valid base64 bytes."); }
		if (bytes.Length > 262144)
			throw new OperationException(OperationFailure.InvalidInput, "The composer body limit is 256 KiB. Broker limits also include headers.");
		var message = new OutgoingMessage(bytes) { MessageId = draft.MessageId };
		if (draft.Subject.Length > 0)
			message.Subject = draft.Subject;
		if (draft.ContentType.Length > 0)
			message.ContentType = draft.ContentType;
		if (draft.CorrelationId.Length > 0)
			message.CorrelationId = draft.CorrelationId;
		if (draft.SessionId.Length > 0)
			message.SessionId = draft.SessionId;
		if (draft.ReplyTo.Length > 0)
			message.ReplyTo = draft.ReplyTo;
		if (draft.ReplyToSessionId.Length > 0)
			message.ReplyToSessionId = draft.ReplyToSessionId;
		if (draft.To.Length > 0)
			message.To = draft.To;
		if (draft.PartitionKey.Length > 0)
			message.PartitionKey = draft.PartitionKey;
		if (draft.TtlDuration is not null)
		{
			if (draft.TtlSeconds is not null || draft.TtlDuration.Length > 64 || !TimeSpan.TryParseExact(draft.TtlDuration, "c", Culture, out var duration) || duration <= TimeSpan.Zero)
				throw new OperationException(OperationFailure.InvalidInput, "Use a positive exact TTL duration or seconds, not both.");
			message.TimeToLive = duration;
		}
		else if (draft.TtlSeconds is int ttl)
			message.TimeToLive = TimeSpan.FromSeconds(ttl);
		foreach (var property in draft.Properties)
		{
			Check(property.Name, 128, true);
			Check(property.Value, 4096);
			if (message.ApplicationProperties.ContainsKey(property.Name))
				throw new OperationException(OperationFailure.InvalidInput, "Application property names must be unique.");
			try
			{
				object value = property.Type switch
				{
					"string" => property.Value,
					"boolean" => property.Value switch { "true" => true, "false" => false, _ => throw new FormatException() },
					"int32" => int.Parse(property.Value, NumberStyles.AllowLeadingSign, Culture),
					"int64" => long.Parse(property.Value, NumberStyles.AllowLeadingSign, Culture),
					"uint64" => ulong.Parse(property.Value, NumberStyles.None, Culture),
					"double" => double.TryParse(property.Value, NumberStyles.Float, Culture, out var number) && double.IsFinite(number) ? number : throw new FormatException(),
					"decimal" => ExactDecimal(property.Value),
					"guid" => Guid.Parse(property.Value),
					"datetime" => System.Text.RegularExpressions.Regex.IsMatch(property.Value, @"(Z|[+-]\d{2}:\d{2})$")
						? DateTimeOffset.ParseExact(property.Value, ["yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK"], Culture, DateTimeStyles.None).UtcDateTime : throw new FormatException(),
					"timespan" => TimeSpan.ParseExact(property.Value, "c", Culture),
					_ => throw new FormatException()
				};
				message.ApplicationProperties.Add(property.Name, value);
			}
			catch (Exception error) when (error is FormatException or OverflowException)
			{
				throw new OperationException(OperationFailure.InvalidInput, "An application property has an invalid value for its declared type. Use round-trip UTC timestamps and invariant numbers.");
			}
		}
		return message;
	}
	public static OutgoingMessage Replay(ReceivedMessage original, string policy, [NotNull] string? messageId)
	{
		Check(messageId, 128, true);
		if (policy is not ("preserve" or "new") || (policy == "preserve" && messageId != original.MessageId) || (policy == "new" && messageId == original.MessageId))
			throw new OperationException(OperationFailure.InvalidInput, "Choose a new ID or explicitly preserve the original message ID.");
		// Preserve the source envelope; the broker adapter clones its native body without re-encoding.
		var copy = new OutgoingMessage(original) { MessageId = messageId, ScheduledEnqueueTime = default, TransactionPartitionKey = null };
		foreach (var name in new[] { "DeadLetterReason", "DeadLetterErrorDescription" })
			copy.ApplicationProperties.Remove(name);
		if (copy.ApplicationProperties.Values.Any(value => value is byte[] or ArraySegment<byte> or ReadOnlyMemory<byte>))
			throw new OperationException(OperationFailure.InvalidInput, "Replay cannot preserve binary application properties with the current broker limitation. The source is retained; use an explicit compatible message instead.");
		return copy;
	}
	private static decimal ExactDecimal(string text)
	{
		if (!System.Text.RegularExpressions.Regex.IsMatch(text, @"^[+-]?[0-9]+(\.[0-9]+)?$"))
			throw new FormatException();
		var value = decimal.Parse(text, NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint, Culture);
		static string Normalize(string text)
		{
			var negative = text.StartsWith('-');
			var parts = text.TrimStart('+', '-').Split('.');
			var whole = parts[0].TrimStart('0');
			var fraction = parts.Length > 1 ? parts[1].TrimEnd('0') : "";
			return (negative && (whole.Length > 0 || fraction.Length > 0) ? "-" : "") + (whole.Length == 0 ? "0" : whole) + (fraction.Length > 0 ? "." + fraction : "");
		}
		// Decimal.Parse can round excess precision; reject that loss instead of changing a typed value silently.
		if (Normalize(text) != Normalize(value.ToString(Culture)))
			throw new FormatException();
		return value;
	}
	private static void Check([NotNull] string? value, int max, bool required = false)
	{
		if (value is null || value.Length > max || (required && string.IsNullOrWhiteSpace(value)))
			throw new OperationException(OperationFailure.InvalidInput, "A message field is missing or exceeds its length limit.");
	}
}
