using Azure;
using Azure.Messaging.ServiceBus;
using MsgCommander.Host;

if (args.Contains("--framed-session-checks"))
	return await FramedSessionChecks.Run();
if (args.Contains("--connection-lifetime-checks"))
	return await ConnectionLifetimeChecks.Run();
if (args.Contains("--receiver-disposal-checks"))
	return await ReceiverDisposalChecks.Run();
if (args.Contains("--messaging-boundary-checks"))
	return await MessagingBoundaryChecks.Run();
if (args.Contains("--administration-boundary-checks"))
	return await AdministrationBoundaryChecks.Run();
if (args.Contains("--configuration-boundary-checks"))
	return await ConfigurationBoundaryChecks.Run();
if (args.Contains("--interactive-boundary-checks"))
	return await InteractiveBoundaryChecks.Run();
if (args.Contains("--maintenance-boundary-checks"))
	return await MaintenanceBoundaryChecks.Run();
if (args.Contains("--workspace-boundary-checks"))
	return await WorkspaceBoundaryChecks.Run();
if (args.Contains("--eventhubs-boundary-checks"))
	return await EventHubsBoundaryChecks.Run();
if (args.Contains("--eventhubs-emulator-checks"))
	return await EventHubsEmulatorChecks.Run();
if (args.Contains("--eventgrid-boundary-checks"))
	return await EventGridBoundaryChecks.Run();
if (args.Contains("--eventgrid-docker-checks"))
	return await EventGridDockerChecks.Run();
if (args.Contains("--message-defer-checks"))
	return await MessageDeferChecks.Run();
if (args.Contains("--event-grid-receive-checks"))
	return await EventGridReceivingChecks.Run();
if (args.Contains("--event-grid-publish-checks"))
	return await EventGridPublishingChecks.Run();
if (args.Contains("--event-grid-delivery-checks"))
	return await EventGridDeliveryChecks.Run();
if (args.Contains("--event-grid-admin-checks"))
	return await EventGridAdministrationChecks.Run();
if (args.Contains("--event-grid-checks"))
	return await EventGridAdapterChecks.Run();
if (args.Contains("--nh-jobs-checks"))
	return await NotificationHubJobsChecks.Run();
if (args.Contains("--nh-data-boundary-checks"))
	return await NotificationHubDataBoundaryChecks.Run();
if (args.Contains("--relay-boundary-checks"))
	return await RelayBoundaryChecks.Run();
if (args.Contains("--provider-failure-checks"))
	return ProviderFailureMappingChecks.Run();
if (args.Contains("--nh-registration-files-checks"))
	return await NotificationHubRegistrationFileChecks.Run();
if (args.Contains("--nh-notification-checks"))
	return await NotificationTestSendChecks.Run();
if (args.Contains("--nh-registration-management-checks"))
	return await NotificationHubRegistrationManagementChecks.Run();
if (args.Contains("--nh-registrations-checks"))
	return await NotificationHubRegistrationsAdapterChecks.Run();
if (args.Contains("--nh-config-checks"))
	return await NotificationHubConfigurationChecks.Run();
if (args.Contains("--nh-management-boundary-checks"))
	return await NotificationHubManagementBoundaryChecks.Run();
if (args.Contains("--nh-management-docker-checks"))
	return await NotificationHubManagementDockerChecks.Run();
if (args.Contains("--nh-credentials-checks"))
	return await NotificationHubCredentialChecks.Run();
if (args.Contains("--nh-checks"))
	return await NotificationHubAdapterChecks.Run();
if (args.Contains("--hybrid-checks"))
	return await HybridAdapterChecks.Run();
if (args.Contains("--relay-checks"))
	return await RelayAdapterChecks.Run();
if (args.Contains("--iot-hub-checks"))
	return await IotHubAdapterChecks.Run();
if (args.Contains("--event-hubs-listening-checks"))
	return await EventHubsListeningAdapterChecks.Run();
if (args.Contains("--event-hubs-admin-checks"))
	return await EventHubsAdministrationAdapterChecks.Run();
if (args.Contains("--event-hubs-send-checks"))
	return await EventHubsSendingAdapterChecks.Run();
if (args.Contains("--event-hubs-checks"))
	return await EventHubsAdapterChecks.Run();
if (args.Contains("--test-job-checks"))
	return await TestJobAdapterChecks.Run();
if (args.Contains("--runtime-checks"))
	return await RuntimeAdapterChecks.Run();
if (args.Contains("--copy-checks"))
	return await EntityAdapterChecks.RunCopyChecks();
if (args.Contains("--authorization-checks"))
	return await AuthorizationAdapterChecks.Run();
if (args.Contains("--receive-delete-checks"))
	return await ReceiveDeleteAdapterChecks.Run();
if (args.Contains("--purge-checks"))
	return await PurgeAdapterChecks.Run();
if (args.Contains("--session-checks"))
	return await SessionAdapterChecks.Run();
if (args.Contains("--scheduling-checks"))
	return await SchedulingAdapterChecks.Run();
if (args.Contains("--adapter-checks"))
	return await AdapterChecks.Run();
if (args.Contains("--mutation-checks"))
	return await MutationAdapterChecks.Run();
if (args.Contains("--entity-checks"))
	return await EntityAdapterChecks.Run();
if (args.Contains("--rule-checks"))
	return await RuleAdapterChecks.Run();
return await MsgCommander.Host.Program.RunAsync(new FixtureFactory(), new FixtureEventHubsFactory(), new FixtureRelayFactory(), new FixtureHybridFactory(), new FixtureNotificationHubFactory(), new FixtureNotificationHubRegistrationsFactory(), new FixtureEventGridFactory());
// Separate executable, never included in the production host or installer.
sealed class FixtureFactory : IServiceBusGatewayFactory
{
	public async Task<IAuthorizationGateway> ConnectAuthorizationAsync(AuthorizationContext context, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		if (context.TenantId == "denied")
			throw new Azure.RequestFailedException(403, "SECRET permission denied");
		if (context.TenantId == "slow")
		{
			await deviceCode(new("OFFLINE-CODE", MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow.AddMinutes(5))));
			await Task.Delay(10000, cancellation);
		}

		return new FixtureAuthorization(context.ResourceId, deviceCode);
	}

	private readonly Dictionary<string, FixtureGateway> recoveryNamespaces = [];
	public async Task<IServiceBusGateway> ConnectAsync(ConnectionProfile profile, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		if (profile.Namespace == "fixture.servicebus.windows.net")
			return new FixtureGateway();
		if (profile.Namespace is not ("recovery.fixture.servicebus.windows.net" or "recovery-slow.fixture.servicebus.windows.net" or "recovery-denied.fixture.servicebus.windows.net" or "recovery-cleanup.fixture.servicebus.windows.net"))
			throw new OperationException(OperationFailure.InvalidInput, "The offline test host only accepts fixture namespaces.");
		if (profile.Namespace == "recovery-denied.fixture.servicebus.windows.net")
			throw new UnauthorizedAccessException("SECRET destination auth");
		if (profile.Auth == "device-code" || profile.Namespace == "recovery-slow.fixture.servicebus.windows.net")
			await deviceCode(new("OFFLINE-RECOVERY", MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow.AddMinutes(5))));
		if (profile.Namespace == "recovery-slow.fixture.servicebus.windows.net")
			await Task.Delay(10000, cancellation);
		if (!recoveryNamespaces.TryGetValue(profile.Namespace, out var gateway))
		{
			gateway = new FixtureGateway
			{
				RecoveryNamespace = profile.Namespace
			};
			recoveryNamespaces.Add(profile.Namespace, gateway);
		}

		return gateway;
	}
}

sealed partial class FixtureGateway : IServiceBusGateway
{
	private static readonly DateTimeOffset Time = DateTimeOffset.Parse("2026-10-10T10:00:00Z");
	public Task<EntityPage> ListAsync(string kind, string? topicName, string? continuationToken, CancellationToken cancellation)
	{
		EntityInfo Item(string name, bool sessions = false) => new(new(kind, name, topicName), "Active", kind == "topic" ? null : sessions);
		var page = kind switch
		{
			"queue" when continuationToken is null => new EntityPage([Item("orders"), Item("sessions", true), Item("empty"), Item("slow"), Item("denied"), Item("deleted"), Item("large"), Item("last-sequence"), Item("budget"), Item("oversized")], "page-2"),
			"queue" when continuationToken == "page-2" => new EntityPage([Item("archive")], null),
			"topic" => new EntityPage([Item("order-events")], null),
			"subscription" when topicName == "order-events" => new EntityPage([Item("billing"), Item("audit", true)], null),
			"subscription" when entitySettings.ContainsKey(new("topic", topicName!)) => new EntityPage([], null),
			_ => throw new OperationException(OperationFailure.InvalidInput, "Invalid fixture page.")
		};
		return Task.FromResult(ProjectEntityPage(page, kind, topicName, continuationToken));
	}

	public Task<EntityDetails> GetEntityAsync(EntityTarget target, CancellationToken cancellation)
	{
		if (target.Name == "deleted" || removedEntities.Contains(target))
			throw new RequestFailedException(404, "SECRET must never reach the UI");
		if (target.Name.StartsWith("copy-", StringComparison.Ordinal) || target.TopicName?.StartsWith("copy-", StringComparison.Ordinal) == true)
		{
			var setting = entitySettings[target];
			var stored = messages.TryGetValue(Key(target), out var bucket) ? bucket : [];
			var alive = stored.Where(m => m.State is not ("completed" or "removed")).ToArray();
			EntityCounts counts = target.Kind == "topic" ? new(Scheduled: MsgCommander.Application.Common.DisplayValues.Number(alive.Count(m => m.State == "scheduled")), SizeBytes: "0") : new(Active: MsgCommander.Application.Common.DisplayValues.Number(alive.Count(m => m.State is "active" or "deferred")), DeadLetter: MsgCommander.Application.Common.DisplayValues.Number(alive.Count(m => m.State == "dead-letter")), Scheduled: target.Kind == "queue" ? MsgCommander.Application.Common.DisplayValues.Number(alive.Count(m => m.State == "scheduled")) : null, Transfer: "0", TransferDeadLetter: "0", Total: MsgCommander.Application.Common.DisplayValues.Number(alive.Length), SizeBytes: "0");
			if (setting.UserMetadata == "missing-counts")
				counts = new();
			return Task.FromResult(new EntityDetails(new(target, setting.Status, setting.RequiresSession), [], counts, null, MsgCommander.Application.Common.DisplayValues.Timestamp(Time)));
		}

		if (entitySettings.TryGetValue(target, out var settings))
			return Task.FromResult(new EntityDetails(new(target, settings.Status, settings.RequiresSession), [MsgCommander.Application.Common.DisplayValues.Property("LockDuration", settings.LockDuration), MsgCommander.Application.Common.DisplayValues.Property("UserMetadata", settings.UserMetadata)], new(Active: "2", DeadLetter: "1", Total: "3"), null, MsgCommander.Application.Common.DisplayValues.Timestamp(Time)));
		return Task.FromResult(new EntityDetails(new(target, "Active", (target.Name is "sessions" or "audit" || target.Name.StartsWith("session-test-", StringComparison.Ordinal))), [MsgCommander.Application.Common.DisplayValues.Property("LockDuration", TimeSpan.FromMinutes(1))], new(Active: "2", DeadLetter: "1", Total: "3"), null, MsgCommander.Application.Common.DisplayValues.Timestamp(Time)));
	}

	public async Task<ReceivedMessage?> PeekOneAsync(EntityTarget target, string subQueue, long fromSequenceNumber, CancellationToken cancellation)
	{
		if (target.Name == "resend-slow-peek")
			await Task.Delay(10000, cancellation);
		MessageSubqueues.Parse(subQueue);
		if (subQueue == "transfer-dead-letter")
			SeedTransfer(target);
		if (TryFixturePeek(target, subQueue, fromSequenceNumber, out var stored))
			return stored;
		if (target.Name == "slow")
			await Task.Delay(10000, cancellation);
		if (target.Name == "denied")
			throw new UnauthorizedAccessException("SECRET access failure");
		if (target.Name == "empty")
			return null;
		if (target.Name == "last-sequence")
			return Message(long.MaxValue, "last", new BinaryData("last"));
		if (target.Name is "large" or "budget" or "oversized")
		{
			var length = target.Name == "large" ? 300_000 : target.Name == "budget" ? 40 * 1024 * 1024 : 65 * 1024 * 1024;
			var next = Math.Max(1, fromSequenceNumber);
			if (next > (target.Name == "budget" ? 2 : 1))
				return null;
			var bytes = new byte[length];
			for (var i = 0; i < bytes.Length; i++)
				bytes[i] = (byte)(i % 251);
			return Message(next, target.Name, new BinaryData(bytes));
		}

		var first = 9007199254740993L;
		if (subQueue == "dead-letter")
			return fromSequenceNumber <= first ? Message(first, "dead-order", new BinaryData("{\"failed\":true}"), true) : null;
		if (fromSequenceNumber <= first)
			return Message(first, "order-001", new BinaryData("{\"orderId\":9007199254740993,\"customer\":\"<script>alert(1)</script>\",\"city\":\"Málaga 🚀\"}"), session: target.Name == "sessions" || target.Name == "audit");
		if (fromSequenceNumber <= first + 3)
			return Message(first + 3, "binary-002", new BinaryData(new byte[] { 0, 255, 128, 65 }));
		return null;
	}

	private static ReceivedMessage Message(long sequence, string id, BinaryData body, bool deadLetter = false, bool session = false)
	{
		var properties = new Dictionary<string, object>
		{
			["unsigned"] = ulong.MaxValue,
			["binary"] = new byte[]
			{
				0,
				255
			},
			["created"] = Time,
			["duration"] = TimeSpan.FromSeconds(90),
			["enabled"] = true
		};
		if (deadLetter)
		{
			properties["DeadLetterReason"] = "ValidationFailed";
			properties["DeadLetterErrorDescription"] = "Missing customer ID";
		}

		return AzureReceivedMessage.Snapshot(ServiceBusModelFactory.ServiceBusReceivedMessage(body: body, messageId: id, subject: "Order received", contentType: "application/json", sessionId: session ? "session-001" : null, sequenceNumber: sequence, enqueuedSequenceNumber: sequence, enqueuedTime: Time, deliveryCount: 2, properties: properties, timeToLive: TimeSpan.FromDays(1), serviceBusMessageState: ServiceBusMessageState.Active));
	}

	public string? RecoveryNamespace
	{
		get; init;
	}

	public ValueTask DisposeAsync()
	{
		if (RecoveryNamespace == "recovery-cleanup.fixture.servicebus.windows.net")
			throw new IOException("SECRET destination dispose");
		return ValueTask.CompletedTask;
	}
}
