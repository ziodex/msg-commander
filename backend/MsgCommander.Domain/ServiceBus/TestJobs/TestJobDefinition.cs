namespace MsgCommander.Domain.ServiceBus.TestJobs;

public sealed class TestJobRuleException(string message) : ArgumentException(message);

// Commander execution rules are independent of transport DTOs and the Azure SDK.
public sealed record TestJobDefinition(string Id, string TargetKind, string TargetName, string? TopicName,
	string Mode, int MaxMessages, int MaxSeconds, int DelayMs, int Workers, int BatchSize,
	string SessionId, string Body, string ContentType, bool Acknowledged, PayloadGenerator Generator,
	string Settlement, string DeadLetterReason, string DeadLetterDescription)
{
	public void Validate()
	{
		if (!Guid.TryParse(Id, out _))
			throw new TestJobRuleException("Invalid test job ID.");
		if (TargetKind is not ("queue" or "topic" or "subscription") || string.IsNullOrWhiteSpace(TargetName) || TargetName.Length > 260 ||
			(TargetKind == "subscription" && (string.IsNullOrWhiteSpace(TopicName) || TopicName.Length > 260)))
			throw new TestJobRuleException("Select a queue or subscription for peeking; subscriptions require their topic.");
		if (Mode is not ("send" or "receive") || (Mode == "send" && TargetKind == "subscription") ||
			(Mode == "receive" && TargetKind == "topic") || MaxMessages is < 1 or > 100000 || MaxSeconds is < 1 or > 600 ||
			DelayMs is < 0 or > 1000 || Workers is < 1 or > 8 || BatchSize is < 1 or > 100 ||
			SessionId is null || SessionId.Length > 128 || Body is null || Body.Length > 65536 ||
			ContentType is null || ContentType.Length > 128 || (Mode == "receive" && (Body.Length > 0 || ContentType.Length > 0)) || !Acknowledged)
			throw new TestJobRuleException("Acknowledge the test job and choose a compatible target, 1–100000 messages, 1–600 seconds, 1–8 workers, batch size 1–100 and 0–1000 ms delay.");
		if (Settlement is not ("complete" or "abandon" or "defer" or "dead-letter") ||
			(Mode == "send" && Settlement != "complete") || (Mode == "receive" && Generator.Kind != "literal") ||
			(Settlement == "defer" && MaxMessages > 1000) || DeadLetterReason is null || DeadLetterDescription is null ||
			DeadLetterReason.Length > 128 || DeadLetterDescription.Length > 1024 ||
			(Settlement == "dead-letter" ? string.IsNullOrWhiteSpace(DeadLetterReason) : DeadLetterReason.Length + DeadLetterDescription.Length > 0))
			throw new TestJobRuleException("Choose Complete, Abandon, Defer (at most 1000 messages), or Dead-letter with a reason. Send tests do not accept settlement settings.");
		TestPayloads.Validate(Generator, Body, ContentType);
		if (Mode == "receive" && SessionId.Length > 0 && Workers != 1)
			throw new TestJobRuleException("Use one receive worker for a selected session.");
	}
}
