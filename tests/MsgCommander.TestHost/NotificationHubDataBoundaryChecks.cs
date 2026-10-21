using MsgCommander.Application.NotificationHubs.Connections;
using MsgCommander.Application.NotificationHubs.Gateways;
using MsgCommander.Infrastructure.NotificationHubs.Registrations;

static class NotificationHubDataBoundaryChecks
{
	static string Id() => Guid.NewGuid().ToString();
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}

	static async Task Failure(Func<Task> action, OperationFailure failure)
	{
		try
		{
			await action();
			throw new Exception("Expected failure: " + failure);
		}
		catch (OperationException error)
		{
			Assert(error.Failure == failure, "Failure ordering: " + error.Message);
		}
	}

	public static async Task<int> Run()
	{
		var factory = new Factory();
		var management = new Management();
		await using var registrations = new NotificationHubRegistrationOwner(factory, management, new AzureRegistrationFileCodec());
		await using var sender = new NotificationHubSenderOwner(factory, management);
		var profile = NotificationHubRegistrationsAdapterChecks.Profile();
		NotificationHubDataConnect Request() => new(new(Id(), profile.Id, "alerts", "profile", null, null, null), profile);
		var connection = await registrations.ConnectAsync(Request, default);
		var senderConnection = await sender.ConnectAsync(Request, default);
		await Failure(async () => await registrations.ConnectAsync(() => Request() with { Profile = profile with { Id = Id() } }, default), OperationFailure.InvalidInput);
		Assert(registrations.Connection == connection && sender.Connection == senderConnection, "Invalid setup preserves both current owners");
		await Failure(async () => await registrations.ExecuteAsync<int>(Id(), "invalid", (_, _) => Task.FromResult(1), default), OperationFailure.ConnectionExpired);
		await Failure(async () => await registrations.ExecuteAsync<int>(connection.ConnectionId, "invalid", (_, _) => Task.FromResult(1), default), OperationFailure.InvalidInput);
		factory.Created[0].FailDispose = true;
		await registrations.ResetAsync(default);
		Assert(registrations.Connection is null && sender.Connection == senderConnection, "Reset invalidates its generation only");
		var count = factory.Created.Count;
		await Failure(async () => await registrations.ConnectAsync(Request, default), OperationFailure.OperationBlocked);
		Assert(factory.Created.Count == count, "Failed cleanup blocks replacement acquisition");
		factory.Created[0].FailDispose = false;
		connection = await registrations.ConnectAsync(Request, default);
		Assert(factory.Created[0].Disposals == 3, "Explicit reconnect retries retained failed cleanup");
		using (var stop = new CancellationTokenSource())
		{
			factory.OnCreate = stop.Cancel;
			try
			{
				await registrations.ConnectAsync(Request, stop.Token);
				throw new Exception("Cancelled acquisition published");
			}
			catch (OperationCanceledException)
			{
			}

			Assert(registrations.Connection is null && factory.Created[^1].Disposals == 1, "Unpublished cancelled client disposed");
			factory.OnCreate = null;
		}

		var adminId = Id();
		NotificationHubDataConnect Policy() => new(Request().Setup with
		{
			Source = "policy",
			ManagementConnectionId = adminId,
			PolicyTarget = new(new("hub", "alerts"), "Manage"),
			KeyType = "PrimaryKey"
		}, profile);
		connection = await registrations.ConnectAsync(Policy, default);
		Assert(management.LastCredential?.Sending == false, "Registration policy requires Manage access");
		senderConnection = await sender.ConnectAsync(Policy, default);
		Assert(management.LastCredential?.Sending == true, "Sender policy uses its distinct access requirement");
		management.Expired = true;
		var invoked = false;
		await Failure(async () => await registrations.ExecuteAsync<int>(connection.ConnectionId, Id(), (_, _) =>
		{
			invoked = true;
			return Task.FromResult(1);
		}, default), OperationFailure.ConnectionExpired);
		Assert(!invoked, "Expired policy generation cannot enter workflow");
		await sender.DisconnectAsync(senderConnection.ConnectionId, Id(), default);
		await registrations.DisconnectAsync(connection.ConnectionId, Id(), default);
		Assert(sender.Connection is null && registrations.Connection is null, "Stale policy connections can still be disconnected");
		Console.WriteLine("Notification Hubs data boundary checks passed");
		return 0;
	}

	sealed class Management : INotificationHubManagementAccess
	{
		public bool Expired;
		public NotificationHubPolicyCredential? LastCredential;
		public Task RequireAsync(string id, string profile, CancellationToken token) => Expired ? Task.FromException(new OperationException(OperationFailure.ConnectionExpired, "Expired management")) : Task.CompletedTask;
		public Task<ConnectionProfile> CredentialAsync(NotificationHubPolicyCredential request, CancellationToken token)
		{
			LastCredential = request;
			return Task.FromResult(request.Profile with
			{
				Auth = "sas"
			});
		}
	}

	sealed class Factory : INotificationHubRegistrationsGatewayFactory
	{
		public List<Gateway> Created = [];
		public Action? OnCreate;
		public INotificationHubRegistrationsGateway Create(ConnectionProfile profile, string hub)
		{
			var gateway = new Gateway();
			Created.Add(gateway);
			OnCreate?.Invoke();
			return gateway;
		}
	}

	sealed class Gateway : INotificationHubRegistrationsGateway
	{
		public bool FailDispose;
		public int Disposals;
		public ValueTask DisposeAsync()
		{
			Disposals++;
			return FailDispose ? ValueTask.FromException(new IOException("Cleanup failed")) : ValueTask.CompletedTask;
		}

		public Task<NotificationHubRegistrationDetails> GetAsync(string id, CancellationToken token) => throw new NotSupportedException();
		public Task<NotificationHubRegistrationDetails?> ChangeAsync(NotificationHubRegistrationChange change, NotificationHubRegistrationDetails? original, Action dispatch, CancellationToken token) => throw new NotSupportedException();
		public Task<NotificationHubRegistrationGatewayPage> QueryAsync(NotificationHubRegistrationQuery query, string? continuation, CancellationToken token) => throw new NotSupportedException();
		public Task<NotificationHubJobsPage> ListJobsAsync(CancellationToken token) => throw new NotSupportedException();
		public Task<NotificationHubJob> GetJobAsync(string id, CancellationToken token) => throw new NotSupportedException();
		public Task<NotificationHubJob> SubmitJobAsync(NotificationHubJobDraft draft, Action dispatched, Action acknowledged, CancellationToken token) => throw new NotSupportedException();
		public Task<NotificationSendDetails> TestSendAsync(NotificationDraft draft, Action dispatched, CancellationToken token) => throw new NotSupportedException();
	}
}
