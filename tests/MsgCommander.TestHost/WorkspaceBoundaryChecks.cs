using MsgCommander.Application.Connections;
using MsgCommander.Application.ServiceBus.Workspace;
using MsgCommander.Application.ServiceBus.Configuration;
using MsgCommander.Infrastructure.ServiceBus.Administration;
using MsgCommander.Infrastructure.ServiceBus.TestJobs;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.Identity;
using System.Net;
using System.Text;
using System.Text.Json;

static class WorkspaceBoundaryChecks
{
	static string Id() => Guid.NewGuid().ToString();
	static void Assert(bool value, string label)
	{
		if (!value)
			throw new Exception(label);
	}
	static async Task Reject(Func<Task> run, OperationFailure expected)
	{
		try
		{
			await run();
		}
		catch (OperationException error) when (error.Failure == expected) { return; }
		throw new Exception("Expected " + expected);
	}
	static readonly EntityTarget Target = new("queue", "sessions");
	static ServiceBusFailurePolicies Policies() => new(new AzureMessageFailureClassifier(), new AzureMessageMutationFailureClassifier(),
		new AzureMaintenanceFailureClassifier(), new AzureAdministrationFailureClassifier(), new AzureConfigurationFailureClassifier(), TestJobFailureMapper.Translate);
	static ConnectionProfile Profile() => new(Id(), "workspace", "service-bus", "fixture.servicebus.windows.net", "device-code", "", "", "fixture-only");
	public static async Task<int> Run()
	{
		await PromptScopes();
		await SdkPromptFlow();
		var factory = new Factory();
		await using var owner = new ServiceBusConnectionOwner(factory, Policies(), new InMemoryMessageDeferProvider());
		List<string> codes = [];
		var profile = Profile();
		var first = await owner.ConnectAsync(profile, _ => { codes.Add("connect"); return Task.CompletedTask; }, default);
		var oldContext = owner.Current;
		var receiptId = Id();
		await owner.ExecuteAsync(first.ConnectionId, ServiceBusOperation.Shared, _ => { codes.Add("read"); return Task.CompletedTask; }, async (context, token) =>
		{
			await factory.Prompts[0](new("REQUEST", "later"));
			owner.Deferred.Record(context.DeferScope(Target, "active", ""), 9007199254740993);
			await context.Receipts.ExecuteAsync(receiptId, "receipt", MutationScope.Messaging,
				_ => Task.FromResult(new MutationEffect("confirmed")), (_, _, _) => { }, token);
			await context.Interactive.AcceptSessionAsync(new(Target, "owned"), token);
			return 0;
		}, default);
		Assert(codes.SequenceEqual(new[] { "connect", "read" }), "SDK prompts use the current request rather than the original connection callback");
		await Reject(() => factory.Prompts[0](new("LATE", "later")), OperationFailure.AuthenticationRequired);
		var entered = false;
		await Reject(() => owner.ExecuteAsync(first.ConnectionId, ServiceBusOperation.ConfigurationWrite, null,
			(_, _) => { entered = true; return Task.FromResult(0); }, default), OperationFailure.OperationBlocked);
		Assert(!entered && oldContext.Interactive.HasReceiver, "Configuration is blocked before parsing or consuming a review while the receiver remains owned");
		var adapter = new ServiceBusConfigurationGateway(oldContext.Gateway, profile.Namespace, () => null, () => "context", new AzureConfigurationFailureClassifier(),
			() => oldContext.Require(ServiceBusOperation.ConfigurationWrite));
		await Reject(() => adapter.Write(new(new("queue", "blocked", null, null), default, false, null), "resource", "create", null, null, () => { }, default), OperationFailure.OperationBlocked);
		Assert(factory.Clients[0].Writes == 0, "The configuration adapter also checks ownership before any write");
		var second = await owner.ConnectAsync(profile, _ => { codes.Add("reconnect"); return Task.CompletedTask; }, default);
		Assert(second.ConnectionId != first.ConnectionId && factory.Clients[0].Disposed && factory.Clients[0].Receiver.Disposed, "Replacement drains and disposes the prior generation");
		Assert(factory.Events.IndexOf("receiver-close") < factory.Events.IndexOf("gateway-close") && factory.Events.IndexOf("gateway-close") < factory.Events.LastIndexOf("gateway-open"), "Receiver cleanup precedes client disposal and replacement authentication");
		Assert(oldContext.Receipts.Get(receiptId) is null && owner.Current.Receipts.Get(receiptId) is null, "Receipts are cleared with their connection generation");
		Assert(owner.Deferred.List(owner.Current.DeferScope(Target, "active", "")).Items.Single().SequenceNumber == "9007199254740993", "Deferred references retain exact profile/namespace scope across reconnects");
		await Reject(() => owner.ExecuteAsync(first.ConnectionId, ServiceBusOperation.Shared, null, (_, _) => Task.FromResult(0), default), OperationFailure.ConnectionExpired);
		await Reject(() => Task.Run(() => oldContext.Require(ServiceBusOperation.Shared)), OperationFailure.ConnectionExpired);
		await owner.ExecuteAsync(second.ConnectionId, ServiceBusOperation.Shared, _ => { codes.Add("new-read"); return Task.CompletedTask; }, async (_, _) =>
		{
			await Reject(() => factory.Prompts[0](new("OLD-GENERATION", "later")), OperationFailure.AuthenticationRequired);
			await factory.Prompts[1](new("NEW-GENERATION", "later"));
			return 0;
		}, default);
		Assert(codes.Last() == "new-read" && codes.Count == 4, "A closed connection's callback cannot attach to a new generation's request");

		var listenerId = Id();
		await owner.ExecuteAsync(second.ConnectionId, ServiceBusOperation.Shared, null, (context, token) =>
			context.StartListenerAsync(new(listenerId, Target, "manual", "owned", 1, 30, 10, "single", 1, 5), "listener", token), default);
		var foregroundEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
		var finishForeground = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
		var foreground = owner.ExecuteAsync(second.ConnectionId, ServiceBusOperation.Shared, null, async (_, _) =>
		{
			foregroundEntered.SetResult();
			await finishForeground.Task;
			return 0;
		}, default);
		await foregroundEntered.Task;
		Assert(owner.ListenerStatus(second.ConnectionId)?.Status == "running", "Listener status remains available while foreground work holds the gate");
		await owner.StopListenerAsync(second.ConnectionId, listenerId).WaitAsync(TimeSpan.FromSeconds(3));
		Assert(!foreground.IsCompleted, "Stopping the listener does not wait for the foreground operation gate");
		finishForeground.SetResult();
		await foreground;

		var failingFactory = new Factory();
		await using var failingOwner = new ServiceBusConnectionOwner(failingFactory, Policies(), new InMemoryMessageDeferProvider());
		var failedConnection = await failingOwner.ConnectAsync(Profile(), _ => Task.CompletedTask, default);
		await failingOwner.ExecuteAsync(failedConnection.ConnectionId, ServiceBusOperation.Shared, null,
			(context, token) => context.Interactive.AcceptSessionAsync(new(Target, "owned"), token), default);
		failingFactory.Clients[0].Receiver.DisposalFailure = new IOException("fixture cleanup failure");
		try
		{
			await failingOwner.ResetAsync(default);
			throw new Exception("Expected cleanup failure");
		}
		catch (IOException) { }
		Assert(failingOwner.Connection is null && failingFactory.Clients[0].Disposed, "A receiver cleanup failure still clears identity and attempts gateway cleanup");
		await Reject(() => failingOwner.ConnectAsync(Profile(), _ => Task.CompletedTask, default), OperationFailure.OperationBlocked);
		Assert(failingFactory.Clients.Count == 1, "Unconfirmed cleanup blocks replacement without opening another client");

		using var cancelled = new CancellationTokenSource();
		var cancelledFactory = new Factory { AfterConnect = () => cancelled.Cancel() };
		await using var cancelledOwner = new ServiceBusConnectionOwner(cancelledFactory, Policies(), new InMemoryMessageDeferProvider());
		try
		{
			await cancelledOwner.ConnectAsync(Profile(), _ => Task.CompletedTask, cancelled.Token);
			throw new Exception("Expected cancellation");
		}
		catch (OperationCanceledException) { }
		Assert(cancelledOwner.Connection is null && cancelledFactory.Clients[0].Disposed, "A cancelled acquisition disposes the unpublished candidate context");
		Console.WriteLine("Workspace boundary checks passed");
		return 0;
	}
	static async Task PromptScopes()
	{
		var prompts = new DeviceCodePrompts();
		List<string> seen = [];
		var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
		Task? late;
		using (prompts.Enter(_ => { seen.Add("old"); return Task.CompletedTask; }, default))
		{
			await prompts.ForwardAsync(new("LIVE", "later"));
			late = Task.Run(async () => { await release.Task; await Reject(() => prompts.ForwardAsync(new("STALE", "later")), OperationFailure.AuthenticationRequired); });
		}
		using (prompts.Enter(_ => { seen.Add("new"); return Task.CompletedTask; }, default))
		{
			release.SetResult();
			await late;
			await prompts.ForwardAsync(new("CURRENT", "later"));
		}
		Assert(seen.SequenceEqual(new[] { "old", "new" }), "Background continuations cannot reuse a completed prompt scope or borrow another request's callback");
		using var cancelled = new CancellationTokenSource();
		cancelled.Cancel();
		using (prompts.Enter(_ => throw new Exception("Must not forward"), cancelled.Token))
		{
			try
			{
				await prompts.ForwardAsync(new("CANCELLED", "later"));
				throw new Exception("Expected cancellation");
			}
			catch (OperationCanceledException) { }
		}
		prompts.Close();
		await Reject(() => Task.Run(() => prompts.Enter(_ => Task.CompletedTask, default)), OperationFailure.AuthenticationRequired);
	}
	static async Task SdkPromptFlow()
	{
		var tenant = Id();
		var wire = new IdentityWire(tenant);
		using var http = new HttpClient(wire);
		using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(5));
		var prompts = new DeviceCodePrompts();
		var received = 0;
		using var request = prompts.Enter(code =>
		{
			Assert(code.Code == "FIXTURE-CODE", "The actual SDK callback retains the request's logical execution scope");
			received++;
			return Task.CompletedTask;
		}, cancellation.Token);
		var credential = new DeviceCodeCredential(new DeviceCodeCredentialOptions
		{
			TenantId = tenant,
			ClientId = Id(),
			DisableInstanceDiscovery = true,
			Transport = new HttpClientTransport(http),
			Retry = { MaxRetries = 0 },
			DeviceCodeCallback = async (code, token) =>
			{
				token.ThrowIfCancellationRequested();
				await prompts.ForwardAsync(new(code.UserCode, MsgCommander.Application.Common.DisplayValues.Timestamp(code.ExpiresOn)));
				cancellation.Cancel();
			}
		});
		var administration = new Azure.Messaging.ServiceBus.Administration.ServiceBusAdministrationClient("fixture.servicebus.windows.net", credential,
			new Azure.Messaging.ServiceBus.Administration.ServiceBusAdministrationClientOptions { Transport = new HttpClientTransport(http), Retry = { MaxRetries = 0 } });
		try
		{
			await administration.GetNamespacePropertiesAsync(cancellation.Token);
			throw new Exception("Expected cancellation after the fixture prompt");
		}
		catch (OperationCanceledException) { }
		Assert(received == 1 && wire.DeviceCodes == 1, "The Service Bus administration/Azure.Identity/MSAL callback path is exercised with in-memory HTTP and no live sign-in");
	}
	sealed class IdentityWire(string tenant) : HttpMessageHandler
	{
		public int DeviceCodes;
		protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
		{
			cancellationToken.ThrowIfCancellationRequested();
			var uri = request.RequestUri!;
			Assert(uri.Host == "login.microsoftonline.com", "Only the fixture identity authority is requested");
			object response;
			if (uri.AbsolutePath.EndsWith("/.well-known/openid-configuration"))
				response = new
				{
					authorization_endpoint = $"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
					token_endpoint = $"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
					issuer = $"https://login.microsoftonline.com/{tenant}/v2.0",
					jwks_uri = "https://login.microsoftonline.com/common/discovery/v2.0/keys"
				};
			else if (uri.AbsolutePath.EndsWith("/devicecode"))
			{
				DeviceCodes++;
				response = new
				{
					device_code = "fixture-device-code",
					user_code = "FIXTURE-CODE",
					verification_uri = "https://microsoft.com/devicelogin",
					expires_in = 300,
					interval = 1,
					message = "Offline fixture"
				};
			}
			else
				throw new Exception("Unexpected offline identity request: " + uri.AbsolutePath);
			return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(response), Encoding.UTF8, "application/json") });
		}
	}
	sealed class Factory : IServiceBusGatewayFactory
	{
		public readonly List<string> Events = [];
		public readonly List<Gateway> Clients = [];
		public readonly List<Func<DeviceCodeEvent, Task>> Prompts = [];
		public Action? AfterConnect;
		public async Task<IServiceBusGateway> ConnectAsync(ConnectionProfile profile, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
		{
			Events.Add("gateway-open");
			Prompts.Add(deviceCode);
			await deviceCode(new("CONNECT", "later"));
			var gateway = new Gateway(Events);
			Clients.Add(gateway);
			AfterConnect?.Invoke();
			return gateway;
		}
		public Task<IAuthorizationGateway> ConnectAuthorizationAsync(AuthorizationContext context, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation) => throw new NotSupportedException();
	}
	sealed class Gateway(List<string> events) : IServiceBusGateway
	{
		public readonly Receiver Receiver = new(events);
		public bool Disposed;
		public int Writes;
		public Task<EntityDetails> GetEntityAsync(EntityTarget target, CancellationToken cancellation) => Task.FromResult(new EntityDetails(new(target, "Active", true), [], new(), null, MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow)));
		public Task<IMessageReceiver> OpenReceiverAsync(EntityTarget target, string subQueue, string sessionId, CancellationToken cancellation) => Task.FromResult<IMessageReceiver>(Receiver);
		public ValueTask DisposeAsync()
		{
			events.Add("gateway-close");
			Disposed = true;
			return ValueTask.CompletedTask;
		}
		public Task ChangeEntityAsync(string action, EntityTarget target, EntitySettings? settings, string? expectedRevision, Action dispatching, CancellationToken cancellation)
		{
			Writes++;
			throw new NotSupportedException();
		}
		public IAsyncEnumerable<string> ListSessionsAsync(EntityTarget target, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<ReceivedMessage?> PeekOneAsync(EntityTarget target, string subQueue, long fromSequenceNumber, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<IReadOnlyList<long>> SendBatchAsync(EntityTarget target, IReadOnlyList<OutgoingMessage> messages, DateTimeOffset? scheduled, Action dispatching, CancellationToken cancellation) => throw new NotSupportedException();
		public Task CancelScheduledAsync(EntityTarget target, IReadOnlyList<long> sequences, Action dispatching, CancellationToken cancellation) => throw new NotSupportedException();
		public ITestMessageSender OpenTestSender(EntityTarget target) => throw new NotSupportedException();
		public Task SendAsync(EntityTarget target, OutgoingMessage message, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<IMessageReceiver> OpenReceiveDeleteReceiverAsync(EntityTarget target, string subQueue, string sessionId, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<IMessageReceiver> OpenNextSessionAsync(EntityTarget target, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<RuntimePage> ListRuntimeAsync(string kind, string? topicName, string? continuationToken, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<EntityCopyState> GetEntityCopyStateAsync(EntityTarget target, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<bool> EntityExistsAsync(EntityTarget target, CancellationToken cancellation) => throw new NotSupportedException();
		public Task CreateEntityCopyAsync(EntityTarget target, EntitySettings settings, string guardRule, Action dispatching, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<RulePage> ListRulesAsync(EntityTarget target, string? continuation, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<RuleConfiguration> GetRuleAsync(EntityTarget target, string name, CancellationToken cancellation) => throw new NotSupportedException();
		public Task ChangeRuleAsync(string action, EntityTarget target, string name, RuleDefinition? definition, string? expectedRevision, Action dispatching, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<EntityPage> ListAsync(string kind, string? topicName, string? continuationToken, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<EntityConfiguration> GetEntityConfigurationAsync(EntityTarget target, CancellationToken cancellation) => throw new NotSupportedException();
	}
	sealed class Receiver(List<string> events) : IMessageReceiver
	{
		public bool Disposed;
		public Exception? DisposalFailure;
		public string? SessionId => "owned";
		public DateTimeOffset? SessionLockedUntil => DateTimeOffset.UtcNow.AddMinutes(5);
		public async Task<IReadOnlyList<ReceivedMessage>> ReceiveAsync(int count, TimeSpan wait, CancellationToken cancellation)
		{
			await Task.Delay(Timeout.Infinite, cancellation);
			return [];
		}
		public ValueTask DisposeAsync()
		{
			events.Add("receiver-close");
			Disposed = true;
			if (DisposalFailure is not null)
				throw DisposalFailure;
			return ValueTask.CompletedTask;
		}
		public Task RenewSessionLockAsync(CancellationToken cancellation) => Task.CompletedTask;
		public Task<MessageBody?> GetSessionStateAsync(CancellationToken cancellation) => Task.FromResult<MessageBody?>(null);
		public Task SetSessionStateAsync(MessageBody? state, CancellationToken cancellation) => Task.CompletedTask;
		public Task<ReceivedMessage> ReceiveDeferredAsync(long sequence, CancellationToken cancellation) => throw new NotSupportedException();
		public DateTimeOffset LockedUntil(ReceivedMessage message) => DateTimeOffset.UtcNow.AddMinutes(5);
		public Task SettleAsync(ReceivedMessage message, string action, string reason, string description, CancellationToken cancellation) => Task.CompletedTask;
		public Task ReplayAsync(ReceivedMessage original, EntityTarget destination, OutgoingMessage outgoing, CancellationToken cancellation) => throw new NotSupportedException();
	}
}
