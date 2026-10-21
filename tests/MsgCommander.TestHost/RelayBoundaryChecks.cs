using MsgCommander.Application.Common;
using MsgCommander.Application.Relay.Connections;

static class RelayBoundaryChecks
{
	static string Id() => Guid.NewGuid().ToString();
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}

	static async Task Reject(Func<Task> action, OperationFailure failure)
	{
		try
		{
			await action();
		}
		catch (OperationException error) when (error.Failure == failure)
		{
			return;
		}

		throw new Exception("Expected " + failure);
	}

	sealed class Clock : TimeProvider
	{
		public DateTimeOffset Now = DateTimeOffset.UtcNow;
		public override DateTimeOffset GetUtcNow() => Now;
	}

	public static async Task<int> Run()
	{
		var factory = new Factory();
		var clock = new Clock();
		await using var owner = new RelayConnectionOwner(factory, new AzureRelayFailureClassifier(), clock);
		RelayManagementConnect Request() => new(Id(), new(Id(), "Fixture", "relay", "fixture.servicebus.windows.net", "device-code", "fixture", Id(), null), new(FixtureRelayFactory.Root, "fixture", Id()));
		var connection = await owner.ConnectAsync(Request, null, default);
		await Reject(() => factory.Prompt!(new("expired", "tomorrow")), OperationFailure.AuthenticationRequired);
		var forwarded = 0;
		await owner.ExecuteAsync(connection.ConnectionId, Id(), _ =>
		{
			forwarded++;
			return Task.CompletedTask;
		}, async (context, token) =>
		{
			await factory.Prompt!(new("current", "tomorrow"));
			var settings = new RelaySettings("fixture", true, null, null);
			var archive = new RelayConfigArchive(RelayConfiguration.Format, 1, clock.Now.ToString("O"), connection.Namespace, [new("hybrid", "boundary-one", settings, []), new("hybrid", "boundary-two", settings, [])], [], []);
			var preview = await context.Configuration.PreviewAsync(() => archive, token);
			var request = new RelayConfigApply(Id(), connection.ConnectionId, preview.ImportId, preview.Entries.Select(e => e.Id).ToArray(), true);
			var progress = 0;
			var receipt = await context.Configuration.ApplyAsync(request, "stable", _ => ++progress == 1 ? Task.CompletedTask : throw new IOException("Progress closed"), token);
			Assert(receipt.Status == "cancelled" && receipt.Steps[0].Status == "confirmed" && receipt.Steps[1].Status == "not-attempted", "Progress failure retains confirmed writes");
			var writes = factory.Wire.Requests.Count(r => r.Method == "PUT");
			Assert(await context.Configuration.ApplyAsync(request, "stable", _ => throw new Exception("Replayed progress"), token) == receipt, "Identical operation recovers receipt");
			Assert(writes == factory.Wire.Requests.Count(r => r.Method == "PUT"), "Receipt replay dispatches no write");
			await Reject(async () => await context.Configuration.ApplyAsync(request, "changed", _ => Task.CompletedTask, token), OperationFailure.InvalidInput);
			preview = await context.Configuration.PreviewAsync(() => archive, token);
			clock.Now = clock.Now.AddMinutes(11);
			await Reject(async () => await context.Configuration.ApplyAsync(request with { Id = Id(), ImportId = preview.ImportId, EntryIds = preview.Entries.Select(e => e.Id).ToArray() }, "expired", _ => Task.CompletedTask, token), OperationFailure.InvalidInput);
			return 0;
		}, default);
		Assert(forwarded == 1, "Prompt belongs to current request");
		await Reject(() => factory.Prompt!(new("expired-again", "tomorrow")), OperationFailure.AuthenticationRequired);
		factory.Current!.FailDispose = true;
		await owner.ResetAsync(default);
		var count = factory.Acquisitions;
		await Reject(async () => await owner.ConnectAsync(Request, null, default), OperationFailure.OperationBlocked);
		Assert(factory.Acquisitions == count && owner.Connection is null, "Failed cleanup blocks new generation");
		factory.Current.FailDispose = false;
		connection = await owner.ConnectAsync(Request, null, default);
		await Reject(async () => await owner.ExecuteAsync<int>(Id(), "bad", null, (_, _) => Task.FromResult(1), default), OperationFailure.ConnectionExpired);
		await owner.DisconnectAsync(connection.ConnectionId, Id(), default);
		Console.WriteLine("Relay boundary checks passed");
		return 0;
	}

	sealed class Factory : IRelayGatewayFactory
	{
		public RelayWire Wire = new();
		public Gateway? Current;
		public Func<DeviceCodeEvent, Task>? Prompt;
		public int Acquisitions;
		public async Task<IRelayGateway> ConnectAsync(ConnectionProfile profile, RelayManagement management, Func<DeviceCodeEvent, Task> prompt, CancellationToken token)
		{
			Acquisitions++;
			Prompt = prompt;
			return Current = new(await FixtureRelayFactory.Connect(Wire, token));
		}
	}

	sealed class Gateway(IRelayGateway inner) : IRelayGateway
	{
		public bool FailDispose;
		public string Location => inner.Location;

		public Task<RelayDetails> GetAsync(RelayTarget target, CancellationToken token) => inner.GetAsync(target, token);
		public Task<RelayPage> ListAsync(RelayScope scope, string kind, string? continuation, CancellationToken token) => inner.ListAsync(scope, kind, continuation, token);
		public Task<AuthorizationKey> KeyAsync(RelayTarget target, string keyType, CancellationToken token) => inner.KeyAsync(target, keyType, token);
		public Task ChangeAsync(RelayChange change, Action dispatch, CancellationToken token) => inner.ChangeAsync(change, dispatch, token);
		public ValueTask DisposeAsync() => FailDispose ? ValueTask.FromException(new IOException("Cleanup failed")) : inner.DisposeAsync();
	}
}
