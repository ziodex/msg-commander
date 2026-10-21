using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.AccessPolicies;

static class NotificationHubManagementBoundaryChecks
{
	static string Id() => Guid.NewGuid().ToString();
	static readonly NotificationHubTarget Hub = new(new("hub", "alerts"), null);
	static readonly string Revision = new('A', 64);
	static NotificationHubManagementConnect Request => new(Id(),
		new(Id(), "Fixture", "notification-hubs", "fixture.servicebus.windows.net", "device-code", "fixture", Id(), null),
		new(FixtureNotificationHubFactory.Root, "fixture", Id()));
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
		catch (OperationException error) when (error.Failure == failure) { return; }
		throw new Exception($"Expected {failure}");
	}
	sealed class Clock : TimeProvider
	{
		public DateTimeOffset Now = DateTimeOffset.UtcNow;
		public override DateTimeOffset GetUtcNow() => Now;
	}
	sealed class Material(string provider) : ProviderCredentialMaterial(provider);
	sealed class Codec : IProviderCredentialCodec
	{
		public byte[]? Bytes;
		public bool Fail;
		public Action? Imported;
		public int Builds;
		public DateTimeOffset? NotAfter;
		public ImportedProviderCredential Import(string provider, byte[] bytes, string password)
		{
			Bytes = bytes;
			Imported?.Invoke();
			if (Fail)
				throw new ArgumentException("invalid synthetic credential");
			return new(new Material(provider), "Synthetic credential", NotAfter);
		}
		public ProviderCredentialMaterial Build(ProviderCredentialDraft draft, ProviderCredentialMaterial? imported)
		{
			Builds++;
			return imported ?? new Material(draft.Provider);
		}
	}
	sealed class Failures : INotificationHubFailureClassifier
	{
		public NotificationHubFailure Classify(Exception error) => new(error is OperationException or ArgumentException, false, false);
	}
	sealed class Gateway : INotificationHubGateway
	{
		public string Location => "fixture";
		public int Closes, CloseFailures, Writes, Keys;
		public string[] Rights = ["Manage"];
		public Func<DeviceCodeEvent, Task>? Prompt;
		public bool PromptOnRead, LoseWrite;
		public async Task<NotificationHubDetails> GetAsync(NotificationHubTarget target, CancellationToken cancellation)
		{
			if (PromptOnRead)
				await Prompt!(new("secret-code", "later"));
			return new(target, Revision, null, Rights, [], null);
		}
		public Task<NotificationHubPage> ListAsync(NotificationHubScope scope, string kind, string? continuation, CancellationToken cancellation)
			=> Task.FromResult(new NotificationHubPage([], null));
		public Task<AuthorizationKey> KeyAsync(NotificationHubTarget target, string keyType, CancellationToken cancellation)
		{
			Keys++;
			return Task.FromResult(new AuthorizationKey("SECRET", "Endpoint=sb://fixture/;SharedAccessKey=SECRET"));
		}
		public Task<NotificationHubCredentialStatus> CredentialsAsync(NotificationHubTarget target, string provider, CancellationToken cancellation) => throw new NotSupportedException();
		public Task ChangeCredentialAsync(NotificationHubTarget target, string provider, string revision, ProviderCredentialMaterial? material, Action dispatching, CancellationToken cancellation)
		{
			Writes++;
			dispatching();
			if (LoseWrite)
				throw new IOException("lost reply");
			return Task.CompletedTask;
		}
		public Task ChangeAsync(NotificationHubChange change, Action dispatching, CancellationToken cancellation)
		{
			Writes++;
			dispatching();
			if (LoseWrite)
				throw new IOException("lost reply");
			return Task.CompletedTask;
		}
		public ValueTask DisposeAsync()
		{
			Closes++;
			if (CloseFailures-- > 0)
				throw new IOException("synthetic close failure");
			return ValueTask.CompletedTask;
		}
	}
	sealed class Factory : INotificationHubGatewayFactory
	{
		public Gateway Next = new();
		public Action? Connected;
		public int Calls;
		public Task<INotificationHubGateway> ConnectAsync(ConnectionProfile profile, NotificationHubManagement management, Func<DeviceCodeEvent, Task> code, CancellationToken cancellation)
		{
			Calls++;
			Next.Prompt = code;
			Connected?.Invoke();
			return Task.FromResult<INotificationHubGateway>(Next);
		}
	}
	public static async Task<int> Run()
	{
		await Ownership();
		await Credentials();
		Console.WriteLine("Notification Hubs management boundary checks passed");
		return 0;
	}
	static async Task Ownership()
	{
		var factory = new Factory();
		var codec = new Codec();
		var failures = new Failures();
		await using var owner = new NotificationHubManagementOwner(factory, codec, failures);
		var setup = Request;
		var prompts = 0;
		var first = await owner.ConnectAsync(() => setup, _ => { prompts++; return Task.CompletedTask; }, default);
		var original = factory.Next;
		var policy = new NotificationHubTarget(Hub.Scope, "sender");
		NotificationHubPolicyCredential Access(bool sending = false) => new(first.ConnectionId, setup.Profile, "policy", policy, "PrimaryKey", sending);
		await owner.RequireAsync(first.ConnectionId, setup.Profile.Id, default);
		await Reject(() => owner.RequireAsync(first.ConnectionId, Id(), default), OperationFailure.ConnectionExpired);
		await Reject(() => owner.CredentialAsync(Access() with { Profile = setup.Profile with { Namespace = "other.servicebus.windows.net" } }, default), OperationFailure.InvalidInput);
		original.Rights = ["Send"];
		await Reject(() => owner.CredentialAsync(Access(), default), OperationFailure.AuthenticationRequired);
		Assert(original.Keys == 0, "Registration access never fetches a Send-only key");
		Assert((await owner.CredentialAsync(Access(true), default)).Auth == "sas" && original.Keys == 1, "Sender explicitly accepts Send rights");
		original.PromptOnRead = true;
		await Reject(() => owner.CredentialAsync(Access(true), default), OperationFailure.AuthenticationRequired);
		Assert(prompts == 0, "A later policy credential request cannot borrow the connect prompt");
		original.PromptOnRead = false;
		original.Rights = ["Manage"];
		var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
		var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
		var foreground = owner.ExecuteAsync(first.ConnectionId, Id(), null, async (_, _) => { entered.SetResult(); await release.Task; return 0; }, default);
		await entered.Task;
		using (var cancelled = new CancellationTokenSource())
		{
			var queued = owner.RequireAsync(first.ConnectionId, setup.Profile.Id, cancelled.Token);
			cancelled.Cancel();
			try
			{
				await queued;
				throw new Exception("Queued access ignored cancellation");
			}
			catch (OperationCanceledException) { }
		}
		release.SetResult();
		await foreground;
		Assert((await owner.CredentialAsync(Access(), default)).Secret!.Contains("SECRET"), "Gate remains usable after queued cancellation");
		original.CloseFailures = 2;
		factory.Next = new();
		await Reject(() => owner.ConnectAsync(() => Request, null, default), OperationFailure.OperationBlocked);
		Assert(owner.Connection is null && factory.Calls == 1, "Failed cleanup invalidates the old generation before replacement");
		await Reject(() => owner.ConnectAsync(() => Request, null, default), OperationFailure.OperationBlocked);
		var replacement = await owner.ConnectAsync(() => Request, null, default);
		Assert(original.Closes == 3 && factory.Calls == 2, "Explicit connect retries retained cleanup before opening a client");
		await Reject(() => owner.ExecuteAsync(first.ConnectionId, "invalid", null, (_, _) => Task.FromResult(0), default), OperationFailure.ConnectionExpired);
		await Reject(() => owner.ExecuteAsync(replacement.ConnectionId, "invalid", null, (_, _) => Task.FromResult(0), default), OperationFailure.InvalidInput);
		await owner.ResetAsync(default);
		Assert(owner.Connection is null && factory.Next.Closes == 1, "Reset owns gateway disposal");
		using var duringConnect = new CancellationTokenSource();
		factory.Next = new();
		factory.Connected = duringConnect.Cancel;
		try
		{
			await owner.ConnectAsync(() => Request, null, duringConnect.Token);
			throw new Exception("Cancelled client published");
		}
		catch (OperationCanceledException) { }
		Assert(owner.Connection is null && factory.Next.Closes == 1, "Cancelled candidate is disposed without publishing a connection");
	}
	static async Task Credentials()
	{
		var clock = new Clock();
		var gateway = new Gateway();
		var codec = new Codec();
		var receipts = new NotificationHubReceiptStore();
		var failures = new Failures();
		var credentials = new NotificationHubCredentialService(gateway, codec, failures, receipts, clock);
		NotificationHubCredentialImport Input(NotificationHubTarget? target = null) => new(Id(), Id(), target ?? Hub, "fcm-v1", "", Convert.ToBase64String([1, 2, 3, 4]));
		ProviderCredentialDraft Draft(string artifact) => new("fcm-v1", null, new Dictionary<string, string?> { ["artifactId"] = artifact });
		ProviderCredentialReview Review(NotificationHubTarget? target = null) => new(Id(), target ?? Hub, Revision, true);
		var artifact = credentials.Import(Input(), default);
		Assert(codec.Bytes!.All(x => x == 0), "Decoded private bytes are zeroed after a successful import");
		codec.Fail = true;
		try
		{
			credentials.Import(Input(), default);
			throw new Exception("Invalid import accepted");
		}
		catch (ArgumentException) { }
		Assert(codec.Bytes!.All(x => x == 0), "Decoded private bytes are zeroed after a failed import");
		codec.Fail = false;
		using (var cancelled = new CancellationTokenSource())
		{
			codec.Imported = cancelled.Cancel;
			try
			{
				credentials.Import(Input(), cancelled.Token);
				throw new Exception("Cancelled artifact published");
			}
			catch (OperationCanceledException) { }
			Assert(codec.Bytes!.All(x => x == 0), "Decoded private bytes are zeroed after cancellation");
			codec.Imported = null;
		}
		var review = Review();
		gateway.LoseWrite = true;
		var saved = await credentials.ChangeAsync(review, "unchanged", () => Draft(artifact.ArtifactId), default);
		Assert(saved.Status == "unknown" && gateway.Writes == 1, "A dispatched credential write without a reply remains uncertain");
		Assert(ReferenceEquals(saved, await credentials.ChangeAsync(review, "unchanged", () => throw new Exception("Replay parsed a draft"), default)), "Receipt replay precedes draft parsing");
		await Reject(() => credentials.ChangeAsync(review, "different", () => Draft(artifact.ArtifactId), default), OperationFailure.InvalidInput);
		var administration = new NotificationHubAdministrationService(gateway, failures, receipts);
		var change = new NotificationHubChange(review.Id, Id(), Hub, "create", null, new("30.00:00:00", []), null, null, true);
		await Reject(() => administration.ChangeAsync(change, "admin", default), OperationFailure.InvalidInput);
		Assert(gateway.Writes == 1, "Management and credential writes share their receipt ID namespace");
		gateway.LoseWrite = false;
		var wrongHub = Hub with
		{
			Scope = new("hub", "other")
		};
		Assert((await credentials.ChangeAsync(Review(wrongHub), "foreign", () => Draft(artifact.ArtifactId), default)).Status == "failed", "Artifacts are target-bound");
		credentials.Discard(wrongHub, artifact.ArtifactId);
		Assert((await credentials.ChangeAsync(Review(), "valid", () => Draft(artifact.ArtifactId), default)).Status == "confirmed", "Discard on another target cannot remove the import");
		clock.Now += TimeSpan.FromMinutes(11);
		Assert((await credentials.ChangeAsync(Review(), "expired", () => Draft(artifact.ArtifactId), default)).Status == "failed", "Artifact expiry is enforced before codec or network use");
		codec.NotAfter = clock.Now.AddSeconds(5);
		var shortLived = credentials.Import(Input(), default);
		clock.Now += TimeSpan.FromSeconds(6);
		var builds = codec.Builds;
		Assert((await credentials.ChangeAsync(Review(), "certificate-expired", () => Draft(shortLived.ArtifactId), default)).Status == "failed" && codec.Builds == builds, "Certificate expiry shortens the review lifetime");
		var invalid = Review();
		var failed = await credentials.ChangeAsync(invalid, "invalid-draft", () => throw new OperationException(OperationFailure.InvalidInput, "invalid draft"), default);
		Assert(failed.Status == "failed" && ReferenceEquals(failed, await credentials.ChangeAsync(invalid, "invalid-draft", () => throw new Exception("Reparsed invalid draft"), default)), "Malformed drafts retain an immutable failed receipt");
		Assert(!JsonSerializer.Serialize<ProviderCredentialMaterial>(new Material("fcm-v1")).Contains("Properties"), "Application material exposes provider identity only");
	}
}
