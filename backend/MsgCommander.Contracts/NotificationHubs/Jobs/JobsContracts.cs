namespace MsgCommander.Contracts.NotificationHubs.Jobs;

public sealed record NotificationHubJobDraft(string Type, string? ImportFileUri, string OutputContainerUri)
{
	public override string ToString() => $"NotificationHubJobDraft {{ Type = {Type}, Storage URLs = [redacted] }}";
}

public sealed record NotificationHubJob(string JobId, string Type, string Status, decimal? Progress, string? CreatedAt, string? UpdatedAt, string? OutputContainerUri, string? ImportFileUri, string? OutputFile, string? FailuresFile, bool HasFailure);
public sealed record NotificationHubJobsPage(IReadOnlyList<NotificationHubJob> Items, string CapturedAt, bool MoreAvailable);
public sealed record NotificationHubJobReview(string ReviewId, string Namespace, string HubName, string Type, string? ImportFileUri, string OutputContainerUri, string ExpiresAt, IReadOnlyList<string> Warnings);
public sealed record NotificationHubJobPreview(string Id, string ConnectionId, NotificationHubJobDraft Draft);
public sealed record NotificationHubJobSubmit(string Id, string ConnectionId, string ReviewId, bool Acknowledge);
public sealed record NotificationHubJobOutcome(string OperationId, string Status, string Summary, NotificationHubJob? Job);
