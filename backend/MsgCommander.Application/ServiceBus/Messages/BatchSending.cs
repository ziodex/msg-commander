using System.Globalization;
using MsgCommander.Application.Common;

namespace MsgCommander.Application.ServiceBus.Messages;

public static class BatchSending
{
	public static void Validate(IReadOnlyList<OutgoingMessage> messages)
	{
		if (messages.Count is < 1 or > 20)
			throw new OperationException(OperationFailure.InvalidInput, "Use 1–20 messages per batch.");
		if (messages.Select(message => message.MessageId).Distinct(StringComparer.Ordinal).Count() != messages.Count)
			throw new OperationException(OperationFailure.InvalidInput, "Message IDs must be unique within a batch.");
		if (messages.Select(message => (message.SessionId ?? "", message.PartitionKey ?? "")).Distinct().Count() != 1)
			throw new OperationException(OperationFailure.InvalidInput, "Use the same session ID and partition key for every message in this atomic batch.");
		if (messages.Any(message => !string.IsNullOrEmpty(message.SessionId) && !string.IsNullOrEmpty(message.PartitionKey) && message.SessionId != message.PartitionKey))
			throw new OperationException(OperationFailure.InvalidInput, "When both are set, session ID and partition key must match.");
	}
	public static DateTimeOffset? ParseTime(string? value)
	{
		if (value is null)
			return null;
		if (value.Length > 64 || !System.Text.RegularExpressions.Regex.IsMatch(value, @"T.*(?:Z|[+-]\d{2}:\d{2})$") ||
			!DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.None, out var time))
			throw new OperationException(OperationFailure.InvalidInput, "Use an ISO timestamp with an explicit UTC offset.");
		RequireFuture(time);
		return time.ToUniversalTime();
	}
	public static void RequireFuture(DateTimeOffset time)
	{
		if (time <= DateTimeOffset.UtcNow)
			throw new OperationException(OperationFailure.InvalidInput, "Scheduled enqueue time must be in the future. Review the time and try again.");
	}
	public static long[] Sequences(string[] values)
	{
		if (values.Length is < 1 or > 20 || values.Distinct().Count() != values.Length)
			throw new OperationException(OperationFailure.InvalidInput, "Choose 1–20 distinct scheduled sequence numbers.");
		return values.Select(value => long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var sequence) && sequence >= 0 && value == sequence.ToString(CultureInfo.InvariantCulture)
			? sequence : throw new OperationException(OperationFailure.InvalidInput, "Use nonnegative Int64 sequence numbers as decimal text.")).ToArray();
	}
}
