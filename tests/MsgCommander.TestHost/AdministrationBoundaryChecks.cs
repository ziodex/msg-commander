using MsgCommander.Application.ServiceBus.Administration;
using MsgCommander.Domain.AccessPolicies;
using MsgCommander.Domain.Common;
using MsgCommander.Domain.ServiceBus.Entities;
using MsgCommander.Infrastructure.ServiceBus.Administration;
using MsgCommander.Infrastructure.ServiceBus.Connections;
using Azure;
using Azure.Core;
using ServiceBusAdministrationClient = Azure.Messaging.ServiceBus.Administration.ServiceBusAdministrationClient;
using NamespaceProperties = Azure.Messaging.ServiceBus.Administration.NamespaceProperties;

static class AdministrationBoundaryChecks
{
	static void Assert(bool condition, string message)
	{
		if (!condition)
			throw new Exception(message);
	}
	static void Invalid(Action action)
	{
		try
		{
			action();
		}
		catch (DomainRuleException) { return; }
		throw new Exception("Expected a domain rejection");
	}
	static EntitySettingsDraft Defaults(string kind) => new("Active", "unlimited", "disabled", true, "",
		kind != "topic" ? "00:01:00" : null, kind != "topic" ? 10 : null, kind != "topic" ? false : null,
		kind != "topic" ? "" : null, kind != "topic" ? "" : null, kind != "topic" ? false : null,
		kind != "subscription" ? 1024 : null, null, kind != "subscription" ? false : null,
		kind != "subscription" ? "00:10:00" : null, kind != "subscription" ? false : null,
		kind == "topic" ? false : null, kind == "subscription" ? true : null);

	public static async Task<int> Run()
	{
		var queue = EntityAddress.TryCreate("queue", "orders/incoming")!;
		var topic = EntityAddress.TryCreate("topic", "events")!;
		var subscription = EntityAddress.TryCreate("subscription", "billing", "events")!;
		foreach (var address in new[] { queue, topic, subscription })
		{
			var definition = EntityDefinition.Create(address, Defaults(address.Kind));
			Assert(definition.Address == address && definition.Settings.Status == "Active", "Valid definitions retain their immutable input");
		}
		var settings = Defaults("queue");
		EntityDefinition.Create(queue, settings with
		{
			AutoDeleteOnIdle = "00:05:00",
			LockDuration = "00:05:00",
			DuplicateDetectionHistoryTimeWindow = "7.00:00:00",
			UserMetadata = new string('é', 512)
		});
		foreach (var invalid in new[] {
			settings with { Status = "Creating" }, settings with { AutoDeleteOnIdle = "00:04:59" },
			settings with { LockDuration = "00:05:00.0000001" }, settings with { MaxDeliveryCount = 0 },
			settings with { DuplicateDetectionHistoryTimeWindow = "00:00:19" }, settings with { DuplicateDetectionHistoryTimeWindow = "7.00:00:00.0000001" },
			settings with { UserMetadata = new string('é', 513) }, settings with { MaxSizeInMegabytes = 9007199254740992 },
			settings with { SupportOrdering = false }, settings with { ForwardTo = "ORDERS/incoming" },
			settings with { ForwardDeadLetteredMessagesTo = "orders/../other" }, settings with { RequiresSession = null }
		})
			Invalid(() => EntityDefinition.Create(queue, invalid));
		Invalid(() => EntityDefinition.Create(topic, Defaults("topic") with { Status = "ReceiveDisabled" }));
		Invalid(() => EntityDefinition.Create(subscription, Defaults("subscription") with { Status = "SendDisabled" }));
		Invalid(() => EntityDefinition.Create(subscription, Defaults("subscription") with { ForwardTo = "EVENTS" }));
		Invalid(() => EntityDefinition.Create(subscription, Defaults("subscription") with { MaxMessageSizeInKilobytes = 1024 }));
		Invalid(() => EntityName.Validate(EntityAddress.TryCreate("subscription", new string('a', 51), "events")!));
		foreach (var invalid in new[] { "00:00:00", "-00:00:01", "PT5M", "00:61:00", "disabled" })
			Invalid(() => EntityDuration.Parse(invalid));
		Assert(EntityDuration.Parse("unlimited", "unlimited") == TimeSpan.MaxValue && EntityDuration.Format(TimeSpan.MaxValue, "disabled") == "disabled", "Explicit unbounded duration sentinels remain lossless");
		var creation = new EntityCreationOptions(false, true, false);
		creation.EnsureUnchanged(new(false, true, false));
		Invalid(() => creation.EnsureUnchanged(creation with { RequiresSession = true }));
		Invalid(() => creation.EnsureUnchanged(creation with { RequiresDuplicateDetection = false }));
		Invalid(() => creation.EnsureUnchanged(creation with { EnablePartitioning = true }));

		var original = new[] { "Send", "Manage", "Listen" };
		var rights = PolicyRights.Create(original);
		original[0] = "invalid";
		Assert(rights.Values.SequenceEqual(new[] { "Listen", "Manage", "Send" }), "Policy rights take an owned, canonically ordered copy");
		Assert(((IList<string>)rights.Values).IsReadOnly, "Callers cannot change validated rights");
		foreach (var invalid in new string[]?[] { null, [], ["Manage"], ["Send", "Send"], ["listen"], ["Send", "Listen", "Manage", "Send"] })
			Invalid(() => PolicyRights.Create(invalid));
		Assert(AccessPolicyName.Create("_sender.v2").Value == "_sender.v2", "Supported SAS names are retained");
		foreach (var invalid in new[] { "", ".sender", "sender/path", new string('a', 51) })
			Invalid(() => AccessPolicyName.Create(invalid));
		try
		{
			AccessPolicyRules.Rights(["Manage"]);
			throw new Exception("Expected mapped domain rejection");
		}
		catch (OperationException error) { Assert(error.Failure == OperationFailure.InvalidInput, "Domain rejection maps to a safe application category"); }

		var parameters = new PropertyValue[] { new("@sequence", "int64", "9007199254740993") };
		var prepared = SubscriptionRules.Prepare(new("sql", "sequence = @sequence", parameters, null, "", []));
		parameters[0] = new("@sequence", "int64", "0");
		Assert((long)prepared.FilterParameters["@sequence"] == 9007199254740993, "Prepared rule parameters retain exact Int64 precision and owned values");
		Assert(((IDictionary<string, object>)prepared.FilterParameters).IsReadOnly, "Prepared rule parameters cannot be changed");
		var failure = new AzureAdministrationFailureClassifier();
		Assert(failure.Classify(new Exception("wrapped", new Azure.RequestFailedException(412, "SECRET"))).IsRejected, "Wrapped revision failures remain definite rejection");
		Assert(failure.Classify(new Azure.RequestFailedException(403, "SECRET")).IsPermissionDenied, "Permission failures are classified without exposing SDK errors");
		Assert(!failure.Classify(new TimeoutException()).IsRejected, "Missing acknowledgement remains uncertain");

		await BulkReceipts(failure);
		await AuthorizationSessions();
		await AuthenticationProbe();
		Console.WriteLine("Administration boundary checks passed");
		return 0;
	}

	static async Task BulkReceipts(IAdministrationFailureClassifier failures)
	{
		// Application workflows execute against their administration port without SDK clients or Host dispatch.
		await using var gateway = new FixtureGateway();
		var receiverOpen = true;
		var invalidations = 0;
		var bulk = new EntityBulkService(gateway, "fixture.servicebus.windows.net", () => receiverOpen, () => invalidations++, failures);
		var request = new BulkEntityPreviewRequest([new("queue", "orders")], new("status", "Disabled"), 10);
		try
		{
			await bulk.PreviewAsync(request, default);
			throw new Exception("Expected receiver guard");
		}
		catch (OperationException error) { Assert(error.Failure == OperationFailure.OperationBlocked, "Open receiver blocks entity review"); }
		receiverOpen = false;
		var plan = await bulk.PreviewAsync(request, default);
		var execution = new BulkEntityExecution(Guid.NewGuid().ToString(), plan.PlanId, plan.Confirmation);
		var events = new List<BulkEntityProgress>();
		var result = await bulk.ExecuteAsync(execution, "same-request", value => { events.Add(value); return Task.CompletedTask; }, default);
		Assert(result.Status == "completed" && result.Confirmed == 1 && invalidations == 1, "Typed service confirms exactly one dispatched change");
		Assert(events[0].Items[0].Status == "not-started" && events[^1].Items[0].Status == "confirmed", "Progress events own a stable row snapshot");
		Assert(ReferenceEquals(result, await bulk.ExecuteAsync(execution, "same-request", _ => throw new Exception("Duplicate dispatch"), default)), "Duplicate execution returns its retained receipt");
		Assert(ReferenceEquals(result, bulk.GetResult(execution.Id)) && invalidations == 1, "Receipt lookup never repeats cloud writes");
		try
		{
			await bulk.ExecuteAsync(execution, "different-request", _ => Task.CompletedTask, default);
			throw new Exception("Expected fingerprint guard");
		}
		catch (OperationException error) { Assert(error.Failure == OperationFailure.InvalidInput, "Operation IDs cannot be reused for different requests"); }
	}

	static async Task AuthorizationSessions()
	{
		var factory = new ManagementFactory();
		var service = new AuthorizationService(factory, "fixture.servicebus.windows.net");
		var context = new AuthorizationContext("/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/tests/providers/Microsoft.ServiceBus/namespaces/fixture",
			"tenant.example", "22222222-2222-2222-2222-222222222222");
		var session = await service.ConnectAsync(context, _ => Task.CompletedTask, default);
		var scope = new AuthorizationScope(session.AuthorizationId, new("namespace"));
		Assert((await service.ListAsync(scope, default)).Items.Count == 0 && factory.Gateway.Reads == 1, "Typed session permits its own scope");
		try
		{
			await service.ListAsync(scope with
			{
				AuthorizationId = Guid.NewGuid().ToString()
			}, default);
			throw new Exception("Expected stale session rejection");
		}
		catch (OperationException error) { Assert(error.Failure == OperationFailure.ConnectionExpired && factory.Gateway.Reads == 1, "Stale management IDs never reach the gateway"); }
		var dispatched = 0;
		var change = new AuthorizationChange(scope, "update", "sender", ["Send"], "revision", null, "wrong");
		try
		{
			await service.ChangeAsync(change, () => dispatched++, default);
			throw new Exception("Expected confirmation rejection");
		}
		catch (OperationException error) { Assert(error.Failure == OperationFailure.InvalidInput && dispatched == 0 && factory.Gateway.Writes == 0, "Confirmation is required before dispatch"); }
		var confirmation = AuthorizationRules.Confirmation("update", context.ResourceId, scope.Target, "sender", null);
		await service.ChangeAsync(change with
		{
			Confirmation = confirmation
		}, () => dispatched++, default);
		Assert(dispatched == 1 && factory.Gateway.Writes == 1, "Valid typed policy change reaches its port once");
		using var cancellation = new CancellationTokenSource();
		factory.BeforeReturn = cancellation.Cancel;
		try
		{
			await service.ConnectAsync(context, _ => Task.CompletedTask, cancellation.Token);
			throw new Exception("Expected cancelled candidate rejection");
		}
		catch (OperationCanceledException) { Assert(service.Session is null && service.Gateway is null, "Cancellation cannot publish a candidate management session"); }
		try
		{
			await service.ListAsync(scope, default);
			throw new Exception("Expected cleared session rejection");
		}
		catch (OperationException error) { Assert(error.Failure == OperationFailure.ConnectionExpired, "Replacement invalidates the prior management session"); }
	}

	sealed class ManagementFactory : IAuthorizationGatewayFactory
	{
		public readonly ManagementGateway Gateway = new();
		public Action? BeforeReturn;
		public Task<IAuthorizationGateway> ConnectAuthorizationAsync(AuthorizationContext context, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
		{
			BeforeReturn?.Invoke();
			return Task.FromResult<IAuthorizationGateway>(Gateway);
		}
	}
	sealed class ManagementGateway : IAuthorizationGateway
	{
		public int Reads, Writes;
		public Task<AuthorizationPage> ListAsync(AuthorizationTarget target, CancellationToken cancellation)
		{
			Reads++;
			return Task.FromResult(new AuthorizationPage([]));
		}
		public Task<AuthorizationRule> GetAsync(AuthorizationTarget target, string name, CancellationToken cancellation) => throw new NotSupportedException();
		public Task<AuthorizationKey> KeyAsync(AuthorizationTarget target, string name, string keyType, CancellationToken cancellation) => throw new NotSupportedException();
		public Task ChangeAsync(string action, AuthorizationTarget target, string name, IReadOnlyList<string>? rights, string? expectedRevision, string? keyType, Action dispatching, CancellationToken cancellation)
		{
			dispatching();
			Writes++;
			return Task.CompletedTask;
		}
	}

	static async Task AuthenticationProbe()
	{
		var management = new ProbeAdministration();
		var credential = new ProbeCredential();
		var destinations = new List<string>();
		var probe = new AzureServiceBusAuthenticationProbe(value => { destinations.Add(value); return management; }, (_, _) => credential);
		var profile = new ConnectionProfile(Guid.NewGuid().ToString(), "fixture", "service-bus", "fixture.servicebus.windows.net", "sas", "", "",
			"Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Fixture;SharedAccessKey=ZmFrZQ==");
		var result = await probe.CheckAsync(profile, _ => throw new Exception("Unexpected sign-in"), default);
		Assert(result.Summary.Contains("Manage permission") && management.Reads == 1, "SAS authentication checks namespace metadata without messaging operations");
		var local = profile with
		{
			Namespace = "localhost",
			EmulatorManagementPort = 5300,
			Secret = "Endpoint=sb://localhost:5672;SharedAccessKeyName=Fixture;SharedAccessKey=ZmFrZQ==;UseDevelopmentEmulator=true;"
		};
		await probe.CheckAsync(local, _ => Task.CompletedTask, default);
		Assert(destinations[^1].Contains("Endpoint=sb://localhost:5300/"), "The authentication probe resolves the emulator management port separately from AMQP");
		var entra = await probe.CheckAsync(profile with
		{
			Auth = "device-code"
		}, _ => Task.CompletedTask, default);
		Assert(credential.Reads == 1 && management.Reads == 2 && entra.Summary.Contains("have not been tested"), "Entra probe checks only the Service Bus audience and describes its limits");
		using var cancelled = new CancellationTokenSource();
		cancelled.Cancel();
		try
		{
			await probe.CheckAsync(profile, _ => Task.CompletedTask, cancelled.Token);
			throw new Exception("Expected cancelled probe");
		}
		catch (OperationCanceledException) { Assert(management.Reads == 2, "Cancelled authentication cannot report success"); }
	}
	sealed class ProbeAdministration : ServiceBusAdministrationClient
	{
		public int Reads;
		public override Task<Response<NamespaceProperties>> GetNamespacePropertiesAsync(CancellationToken cancellationToken = default)
		{
			cancellationToken.ThrowIfCancellationRequested();
			Reads++;
			return Task.FromResult<Response<NamespaceProperties>>(null!);
		}
	}
	sealed class ProbeCredential : TokenCredential
	{
		public int Reads;
		public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) => throw new NotSupportedException();
		public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken)
		{
			Assert(requestContext.Scopes.SequenceEqual(new[] { "https://servicebus.azure.net/.default" }), "Authentication never requests a different audience");
			cancellationToken.ThrowIfCancellationRequested();
			Reads++;
			return ValueTask.FromResult(new AccessToken("offline-token", DateTimeOffset.UtcNow.AddMinutes(5)));
		}
	}
}
