using MsgCommander.Application.Common;
using MsgCommander.Application.NotificationHubs.Gateways;
using MsgCommander.Contracts.NotificationHubs.Registrations;
using MsgCommander.Contracts.NotificationHubs.Jobs;
using MsgCommander.Contracts.NotificationHubs.Notifications;
using static MsgCommander.Application.Common.DisplayValues;
using MsgCommander.Application.NotificationHubs.Jobs;

namespace MsgCommander.Application.NotificationHubs.Jobs;

public sealed class NotificationHubJobService(IRegistrationJobsGateway gateway, NotificationHubRegistrationsConnection connection, TimeProvider clock)
{
	private (NotificationHubJobReview Review, NotificationHubJobDraft Draft, DateTimeOffset Expiry)? jobReview;
	private readonly OperationReceipts<NotificationHubJobOutcome> receipts = new(100, "Bulk job operation ID belongs to another request.", "Bulk job receipt limit reached. Review results before reconnecting.");
	public void Clear()
	{
		jobReview = null;
		receipts.Clear();
	}

	public NotificationHubJobOutcome? GetResult(string id) => receipts.Get(id);
	public void Discard() => jobReview = null;
	public Task<NotificationHubJobsPage> ListAsync(CancellationToken cancellation) => gateway.ListJobsAsync(cancellation);
	public Task<NotificationHubJob> GetAsync(string id, CancellationToken cancellation) => gateway.GetJobAsync(id, cancellation);
	public NotificationHubJobReview Preview(Func<NotificationHubJobDraft> readDraft, CancellationToken cancellation)
	{
		jobReview = null;
		var draft = readDraft();
		draft.Validate();
		cancellation.ThrowIfCancellationRequested();
		var expires = clock.GetUtcNow().AddMinutes(10);
		var review = new NotificationHubJobReview(Guid.NewGuid().ToString(), connection!.Namespace, connection.HubName, draft.Type, NotificationHubJobDraftRules.PublicLocation(draft.ImportFileUri), NotificationHubJobDraftRules.PublicLocation(draft.OutputContainerUri)!, Timestamp(expires), ["Storage SAS access must remain valid until Azure finishes this job.", draft.Type == "ExportRegistrations" ? "Exports every registration in this hub, independently of the current query. Output can contain device handles, tags and templates." : "Azure reads every operation in the uploaded line-delimited registration XML file. This is not a Commander JSON/Atom archive; the desktop does not inspect or limit its registration count.", draft.Type == "ImportDeleteRegistrations" ? "This job permanently deletes registrations named in the input file." : draft.Type == "ImportUpdateRegistrations" || draft.Type == "ImportUpsertRegistrations" ? "This job can replace existing registrations, including their device handles, tags and templates." : draft.Type == "ImportCreateRegistrations" ? "This job creates registrations and can duplicate existing device handles." : "Inspect the output and failure files in the chosen Storage container for the export results."]);
		jobReview = (review, draft, expires);
		return review;
	}

	public async Task<NotificationHubJobOutcome> SubmitAsync(NotificationHubJobSubmit submit, string stamp, CancellationToken cancellation)
	{
		submit.Validate();
		if (receipts.CheckRequest(submit.Id, stamp) is { } prior)
			return prior;
		var activeReview = jobReview ?? throw new OperationException(OperationFailure.ConnectionExpired, "Bulk job review expired. Review the Storage URLs again.");
		if (activeReview.Review.ReviewId != submit.ReviewId || activeReview.Expiry <= clock.GetUtcNow())
		{
			jobReview = null;
			throw new OperationException(OperationFailure.ConnectionExpired, "Bulk job review expired. Review again.");
		}

		activeReview.Draft.Validate();
		jobReview = null;
		var dispatched = false;
		var acknowledged = false;
		NotificationHubJob? job = null;
		var status = "accepted";
		var summary = "Azure accepted this bulk job. Refresh its status and inspect output/failure files; acceptance does not mean the registrations succeeded.";
		try
		{
			job = await gateway!.SubmitJobAsync(activeReview.Draft, () => dispatched = true, () => acknowledged = true, cancellation);
		}
		catch (Exception error)
		{
			status = acknowledged ? "accepted" : dispatched && error is not NotificationHubJobRejectedException ? "unknown" : error is OperationCanceledException && cancellation.IsCancellationRequested ? "cancelled" : "failed";
			summary = status switch
			{
				"accepted" => "Azure accepted the bulk job, but its details are unavailable. Refresh jobs to find the Azure job ID. Nothing was retried; Azure continues independently.",
				"unknown" => "Azure may have accepted this bulk job. Refresh jobs and review Azure state before another submission. Nothing was retried; cancelling locally cannot stop an accepted job.",
				"cancelled" => "Cancelled before bulk job dispatch.",
				_ => error is NotificationHubJobRejectedException or OperationException ? error.Message : "Bulk job failed before dispatch. Review the connection and Storage URLs."
			};
		}

		var result = new NotificationHubJobOutcome(submit.Id, status, summary, job);
		receipts.Add(submit.Id, stamp, result);
		return result;
	}
}
