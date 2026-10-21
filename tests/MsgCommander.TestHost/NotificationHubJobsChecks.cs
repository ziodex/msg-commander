using System.Net;
using System.Text.Json;
using MsgCommander.Host;

static class NotificationHubJobsChecks
{
	static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	static string Id() => Guid.NewGuid().ToString();
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}

	sealed class Factory(NotificationHubJobsWire wire) : INotificationHubRegistrationsGatewayFactory
	{
		public INotificationHubRegistrationsGateway Create(ConnectionProfile p, string hub) => new AzureNotificationHubRegistrationsGateway(p, hub, wire);
	}

	sealed class Clock : TimeProvider
	{
		public DateTimeOffset Now = DateTimeOffset.UtcNow;
		public override DateTimeOffset GetUtcNow() => Now;
	}

	public static async Task<int> Run()
	{
		var clock = new Clock();
		var wire = new NotificationHubJobsWire();
		await using var admin = new NotificationHubWorkspace(new FixtureNotificationHubFactory());
		await using var workspace = new NotificationHubRegistrationsWorkspace(new Factory(wire), admin, clock);
		var profile = NotificationHubRegistrationsAdapterChecks.Profile();
		var setup = new NotificationHubRegistrationsConnect(Id(), profile.Id, "alerts", "profile", null, null, null);
		var connection = (NotificationHubRegistrationsConnection)(await workspace.ExecuteAsync("nh.registrations.connect", JsonSerializer.SerializeToElement(new
		{
			request = setup,
			profile
		}, Json), default))!;
		async Task<T> Call<T>(string method, object input, CancellationToken token = default) => (T)(await workspace.ExecuteAsync("nh.registrations.jobs." + method, JsonSerializer.SerializeToElement(input, Json), token))!;
		NotificationHubJobDraft Draft(string type = "ExportRegistrations") => new(type, type == "ExportRegistrations" ? null : NotificationHubJobsWire.Sas(false), NotificationHubJobsWire.Sas());
		Task<NotificationHubJobReview> Review(string type = "ExportRegistrations") => Call<NotificationHubJobReview>("preview", new NotificationHubJobPreview(Id(), connection.ConnectionId, Draft(type)));
		async Task<NotificationHubJobOutcome> Submit(string type = "ExportRegistrations", CancellationToken token = default)
		{
			var p = await Review(type);
			return await Call<NotificationHubJobOutcome>("submit", new NotificationHubJobSubmit(Id(), connection.ConnectionId, p.ReviewId, true), token);
		}

		var review = await Review();
		Assert(wire.Requests.Count == 0 && !JsonSerializer.Serialize(review, Json).Contains("SECRET") && !review.OutputContainerUri.Contains('?'), "Private review does no network and omits SAS");
		var request = new NotificationHubJobSubmit(Id(), connection.ConnectionId, review.ReviewId, true);
		var first = await Call<NotificationHubJobOutcome>("submit", request);
		Assert(first.Status == "accepted" && first.Job?.Status == "Running" && first.Job.Progress == 25.5m, "Submission reports acceptance, not completion");
		var count = wire.Requests.Count;
		Assert(await Call<NotificationHubJobOutcome>("submit", request) == first && wire.Requests.Count == count, "Repeated operation returns retained receipt without replay");
		Assert(await Call<NotificationHubJobOutcome>("result", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			operationId = request.Id
		}) == first, "Receipt recovery");
		try
		{
			await Call<NotificationHubJobOutcome>("submit", request with
			{
				ReviewId = Id()
			});
			throw new Exception("Altered replay accepted");
		}
		catch (OperationException)
		{
		}

		try
		{
			await Call<NotificationHubJobOutcome>("submit", request with
			{
				Id = Id()
			});
			throw new Exception("Consumed review accepted");
		}
		catch (OperationException)
		{
		}

		var page = await Call<NotificationHubJobsPage>("list", new
		{
			id = Id(),
			connectionId = connection.ConnectionId
		});
		Assert(page.Items.Count == 2 && !JsonSerializer.Serialize(page, Json).Contains("SECRET") && page.Items.All(j => j.FailuresFile is null && j.HasFailure), "Job listing redacts SAS, service failure text and foreign URLs");
		var completed = await Call<NotificationHubJob>("get", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			jobId = first.Job!.JobId
		});
		Assert(completed.Status == "Completed" && completed.Progress == 100, "Explicit status refresh");
		wire.RelativeFiles = true;
		var relative = await Call<NotificationHubJob>("get", new
		{
			id = Id(),
			connectionId = connection.ConnectionId,
			jobId = first.Job!.JobId
		});
		wire.RelativeFiles = false;
		Assert(relative.OutputFile == "https://fixturestore.blob.core.windows.net/registrations/alerts/" + first.Job.JobId + "/Output.txt", "Relative Azure output paths resolve beneath the container without SAS");
		foreach (var type in NotificationHubJobDraftRules.Types)
		{
			var job = await Submit(type);
			Assert(job.Status == "accepted" && job.Job!.Type == type, "All export/import job types preserve choice");
		}

		foreach (var code in new[]
		{
			HttpStatusCode.BadRequest,
			HttpStatusCode.Unauthorized,
			HttpStatusCode.Forbidden,
			HttpStatusCode.NotFound,
			HttpStatusCode.Conflict,
			HttpStatusCode.TooManyRequests,
			HttpStatusCode.InternalServerError,
			HttpStatusCode.RequestTimeout,
			HttpStatusCode.Redirect
		}

		)
		{
			wire.Status = code;
			var result = await Submit();
			Assert(result.Status == ((int)code >= 500 || code == HttpStatusCode.RequestTimeout || (int)code < 400 ? "unknown" : "failed") && !result.Summary.Contains("SECRET"), "Definite rejection distinguished from uncertain dispatch");
		}

		wire.Status = null;
		wire.LoseResponse = true;
		var lost = await Submit();
		wire.LoseResponse = false;
		Assert(lost.Status == "unknown" && lost.Job is null, "Lost response does not retry");
		wire.XmlOverride = "<invalid>";
		Assert((await Submit()).Status == "accepted", "HTTP acknowledgment survives malformed details");
		wire.XmlOverride = null;
		using (var late = new CancellationTokenSource())
		{
			wire.OnAcknowledged = late.Cancel;
			var receipt = await Submit(token: late.Token);
			wire.OnAcknowledged = null;
			Assert(receipt.Status == "accepted", "Late cancellation preserves acknowledgment");
		}

		using (var during = new CancellationTokenSource())
		{
			wire.Slow = true;
			during.CancelAfter(30);
			var receipt = await Submit(token: during.Token);
			wire.Slow = false;
			Assert(receipt.Status == "unknown", "Cancel after dispatch is uncertain and server may continue");
		}

		var old = await Review();
		await Review();
		try
		{
			await Call<NotificationHubJobOutcome>("submit", new NotificationHubJobSubmit(Id(), connection.ConnectionId, old.ReviewId, true));
			throw new Exception("Superseded review accepted");
		}
		catch (OperationException)
		{
		}

		old = await Review();
		await Call<object?>("discard", new
		{
			id = Id(),
			connectionId = connection.ConnectionId
		});
		try
		{
			await Call<NotificationHubJobOutcome>("submit", new NotificationHubJobSubmit(Id(), connection.ConnectionId, old.ReviewId, true));
			throw new Exception("Discarded review accepted");
		}
		catch (OperationException)
		{
		}

		old = await Review();
		count = wire.Requests.Count;
		try
		{
			await Call<NotificationHubJobOutcome>("submit", new NotificationHubJobSubmit(Id(), connection.ConnectionId, old.ReviewId, false));
			throw new Exception("Unacknowledged job accepted");
		}
		catch (OperationException)
		{
			Assert(wire.Requests.Count == count, "Acknowledgment required before dispatch");
		}

		clock.Now = clock.Now.AddMinutes(11);
		try
		{
			await Call<NotificationHubJobOutcome>("submit", new NotificationHubJobSubmit(Id(), connection.ConnectionId, old.ReviewId, true));
			throw new Exception("Expired review accepted");
		}
		catch (OperationException)
		{
			Assert(wire.Requests.Count == count, "Expired review never dispatches");
		}

		foreach (var invalid in new[]
		{
			"http://fixturestore.blob.core.windows.net/registrations?sig=SECRET",
			NotificationHubJobsWire.Sas().Replace("blob.core.windows.net", "evil.invalid"),
			NotificationHubJobsWire.Sas().Replace("sp=rwl", "sp=r"),
			NotificationHubJobsWire.Sas() + "&sig=duplicate",
			NotificationHubJobsWire.Sas().Replace("sr=c", "sr=b"),
			NotificationHubJobsWire.Sas() + "#fragment",
			NotificationHubJobsWire.Sas().Replace("/registrations?", "/registrations/blob?"),
			NotificationHubJobsWire.Sas().Replace("se=", "se=invalid"),
			NotificationHubJobsWire.Sas().Replace("sig=SECRET-STORAGE-SAS", "sig="),
			"https://localhost/registrations?sig=SECRET"
		}

		)
		{
			count = wire.Requests.Count;
			try
			{
				await Call<NotificationHubJobReview>("preview", new NotificationHubJobPreview(Id(), connection.ConnectionId, Draft() with
				{
					OutputContainerUri = invalid
				}));
				throw new Exception("Invalid SAS accepted");
			}
			catch (OperationException e)
			{
				Assert(!e.Message.Contains("SECRET") && count == wire.Requests.Count, "Invalid URLs never dispatch or echo tokens");
			}
		}

		count = wire.Requests.Count;
		try
		{
			await Call<NotificationHubJob>("get", new
			{
				id = Id(),
				connectionId = connection.ConnectionId,
				jobId = "../jobs?sig=SECRET"
			});
			throw new Exception("Escaped job ID accepted");
		}
		catch (OperationException)
		{
			Assert(wire.Requests.Count == count, "Job ID cannot escape route");
		}

		wire.Count = 101;
		try
		{
			await Call<NotificationHubJobsPage>("list", new
			{
				id = Id(),
				connectionId = connection.ConnectionId
			});
			throw new Exception("Unbounded jobs accepted");
		}
		catch (OperationException)
		{
		}

		wire.Count = 1;
		wire.HasNext = true;
		page = await Call<NotificationHubJobsPage>("list", new
		{
			id = Id(),
			connectionId = connection.ConnectionId
		});
		Assert(page.MoreAvailable, "Continuation exposed without following arbitrary links");
		wire.HasNext = false;
		foreach (var malformed in new[]
		{
			"<!DOCTYPE x [<!ENTITY x SYSTEM 'file:///SECRET'>]><feed>&x;</feed>",
			"<invalid>",
			new string ('x', 1024 * 1024 + 1)
		}

		)
		{
			wire.XmlOverride = malformed;
			try
			{
				await Call<NotificationHubJobsPage>("list", new
				{
					id = Id(),
					connectionId = connection.ConnectionId
				});
				throw new Exception("Malformed feed accepted");
			}
			catch (OperationException e)
			{
				Assert(!e.Message.Contains("SECRET"), "Malformed jobs response sanitized");
			}
		}

		wire.XmlOverride = null;
		await workspace.ExecuteAsync("nh.registrations.reset", JsonSerializer.SerializeToElement(new
		{
		}), default);
		try
		{
			await Review();
			throw new Exception("Stale connection accepted");
		}
		catch (OperationException)
		{
		}

		Console.WriteLine("Notification Hubs bulk job checks passed");
		return 0;
	}
}
