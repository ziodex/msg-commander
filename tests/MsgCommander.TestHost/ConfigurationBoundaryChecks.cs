using MsgCommander.Domain.Common;
using MsgCommander.Domain.EventHubs;
using MsgCommander.Domain.ResourceConfiguration;
using MsgCommander.Domain.ServiceBus.Entities;

static class ConfigurationBoundaryChecks
{
	static void Assert(bool condition, string description)
	{
		if (!condition)
			throw new Exception(description);
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
	public static async Task<int> Run()
	{
		var properties = new EventHubProperties(4, "Active", "Delete", 24, null, null, "");
		var definition = EventHubDefinition.Create(properties);
		definition.EnsureCanApply("Standard", false, 4, "Delete", "preserve");
		Invalid(() => definition.EnsureCanApply("Basic", true, null, "Delete", "configure"));
		Invalid(() => definition.EnsureCanApply("Standard", false, 2, "Delete", "preserve"));
		definition.EnsureCanApply("Premium", false, 2, "Delete", "preserve");
		Invalid(() => definition.EnsureCanApply("Premium", false, 8, "Delete", "preserve"));
		Invalid(() => definition.EnsureCanApply("Premium", false, 4, "Compact", "preserve"));
		Invalid(() => EventHubDefinition.Create(properties with { CleanupPolicy = "Compact" }));
		Invalid(() => EventHubDefinition.Create(properties with { RetentionHours = 169 }).EnsureCanApply("Standard", true, null, "Delete", "disabled"));
		Invalid(() => EventHubDefinition.Create(properties with { PartitionCount = 33 }).EnsureCanApply("Standard", true, null, "Delete", "disabled"));
		Assert(EventHubName.Validate("$Default", true) == "$Default", "The built-in consumer group has an explicit domain exception");
		Invalid(() => EventHubName.Validate("$Default"));

		var ordered = ImportDependencies.Order([
			new("activate", ["rules"], 4, "subscription"), new("policy", [], 5, "policy"),
			new("rules", ["parent"], 1, "subscription"), new("parent", [], 0, "topic")
		]);
		Assert(ordered.SequenceEqual(new[] { "parent", "rules", "activate", "policy" }), "Dependencies and phase priorities determine stable import order");
		Invalid(() => ImportDependencies.Order([new("a", ["b"], 0, "a"), new("b", ["a"], 0, "b")]));
		Invalid(() => ImportDependencies.Order([new("a", ["missing"], 0, "a")]));
		Invalid(() => ImportDependencies.Order([new("a", [], 0, "a"), new("a", [], 0, "b")]));
		var routes = Enumerable.Range(0, 4).Select(index => new ForwardingRoute(index.ToString(), "queue", "q" + index, null, "q" + (index + 1), "")).ToArray();
		ForwardingGraph.Validate(routes);
		Invalid(() => ForwardingGraph.Validate([.. routes, new("4", "queue", "q4", null, "q5", "")]));
		Invalid(() => ForwardingGraph.Validate([routes[0], new("1", "queue", "q1", null, "Q0", "")]));
		Invalid(() => ForwardingGraph.Validate([
			new("source", "queue", "orders", null, "events", ""), new("subscriber", "subscription", "billing", "events", "", "ORDERS")
		]));
		ForwardingGraph.Validate([new("a", "queue", "a", null, "c", ""), new("b", "queue", "b", null, "c", ""), new("c", "queue", "c", null, "out", "")]);

		foreach (var mode in new[] { WriteMode.Confirmed, WriteMode.LostAcknowledgement, WriteMode.Rejected, WriteMode.VerificationFailed })
		{
			var gateway = new ConfigurationGateway { Mode = mode };
			var service = new MessagingConfigurationService(gateway, new Failures());
			var preview = await service.PreviewAsync(new("event-hubs", Archive()), default);
			var apply = new MessagingConfigApply(Guid.NewGuid().ToString(), "connection", "event-hubs", preview.ImportId, preview.Entries.Select(entry => entry.Id).ToArray(), true);
			var result = await service.ApplyAsync(apply, "request", _ => Task.CompletedTask, default);
			var expected = mode == WriteMode.Confirmed ? "completed" : mode == WriteMode.Rejected ? "failed" : "unknown";
			Assert(result.Status == expected && gateway.Writes == 1, "Acknowledgement and verification determine the receipt without automatic retry");
			Assert(ReferenceEquals(result, service.GetResult("event-hubs", apply.Id)), "The typed result lookup returns its retained receipt");
			Assert(ReferenceEquals(result, await service.ApplyAsync(apply, "request", _ => throw new Exception("Repeated progress"), default)) && gateway.Writes == 1, "Duplicate apply never repeats a write");
			try
			{
				await service.ApplyAsync(apply, "different", _ => Task.CompletedTask, default);
				throw new Exception("Expected request identity rejection");
			}
			catch (OperationException error) { Assert(error.Failure == OperationFailure.InvalidInput, "Receipt identity is bound to its exact request fingerprint"); }
		}
		await ProgressFailureKeepsConfirmation();
		var changedGateway = new ConfigurationGateway();
		var changed = new MessagingConfigurationService(changedGateway, new Failures());
		var review = await changed.PreviewAsync(new("event-hubs", Archive()), default);
		changedGateway.ContextKey = "replacement-management-session";
		try
		{
			await changed.ApplyAsync(new(Guid.NewGuid().ToString(), "connection", "event-hubs", review.ImportId, review.Entries.Select(entry => entry.Id).ToArray(), true), "request", _ => Task.CompletedTask, default);
			throw new Exception("Expected stale context rejection");
		}
		catch (OperationException error) { Assert(error.Failure == OperationFailure.InvalidInput && changedGateway.Writes == 0, "Management replacement invalidates a prepared review before any write"); }
		Console.WriteLine("Configuration boundary checks passed");
		return 0;
	}

	static string Archive(bool multiple = false)
	{
		List<MessagingConfigResource> resources = [new(new("hub", "telemetry", null, null), MessagingConfiguration.Value(new { userMetadata = "synthetic" }), false, null)];
		if (multiple)
			resources.Add(new(new("hub", "telemetry-two", null, null), MessagingConfiguration.Value(new
			{
				userMetadata = "second"
			}), false, null));
		var archive = new MessagingConfigArchive(MessagingConfiguration.Format, 1, "event-hubs", DateTimeOffset.UtcNow.ToString("O"), "fixture.servicebus.windows.net",
			resources, []);
		return Convert.ToBase64String(MessagingConfiguration.Encode(archive, "json"));
	}
	static async Task ProgressFailureKeepsConfirmation()
	{
		var gateway = new ConfigurationGateway();
		var service = new MessagingConfigurationService(gateway, new Failures());
		var review = await service.PreviewAsync(new("event-hubs", Archive(multiple: true)), default);
		var apply = new MessagingConfigApply(Guid.NewGuid().ToString(), "connection", "event-hubs", review.ImportId, review.Entries.Select(entry => entry.Id).ToArray(), true);
		var result = await service.ApplyAsync(apply, "progress-failure", _ => throw new IOException("SECRET progress failure"), default);
		Assert(result.Status == "failed" && result.Steps.Count == 2 && result.Steps[0].Status == "confirmed" && result.Steps[1].Status == "not-attempted" && gateway.Writes == 1,
			"A local progress failure cannot erase a broker acknowledgement and successful verification");
		Assert(ReferenceEquals(result, service.GetResult("event-hubs", apply.Id)), "The confirmed step remains reviewable after progress failure");
	}
	enum WriteMode
	{
		Confirmed, LostAcknowledgement, Rejected, VerificationFailed
	}
	sealed class MissingResource : Exception;
	sealed class RejectedWrite : Exception;
	sealed class Failures : IConfigurationFailureClassifier
	{
		public ConfigurationFailure Classify(Exception error) => new(error is MissingResource, error is MissingResource or RejectedWrite);
	}
	sealed class ConfigurationGateway : IMessagingConfigurationGateway
	{
		public string Service => "event-hubs";
		public string Namespace => "fixture.servicebus.windows.net";
		public string ContextKey { get; set; } = "management-session";
		public WriteMode Mode;
		public int Writes;
		private bool failRead;
		private readonly Dictionary<string, MessagingConfigSnapshot> resources = [];
		public Task<MessagingConfigSnapshot> Read(MessagingConfigTarget target, CancellationToken token)
		{
			token.ThrowIfCancellationRequested();
			if (failRead)
			{
				failRead = false;
				throw new RejectedWrite();
			}
			return resources.TryGetValue(target.Key(), out var resource) ? Task.FromResult(resource) : throw new MissingResource();
		}
		public Task<IReadOnlyList<MessagingConfigResource>> Export(MessagingConfigTarget? scope, bool policies, CancellationToken token) => Task.FromResult<IReadOnlyList<MessagingConfigResource>>(resources.Values.Select(value => value.Resource).ToArray());
		public Task<MessagingConfigResource> Prepare(MessagingConfigResource source, MessagingConfigSnapshot? current, CancellationToken token) => Task.FromResult(source);
		public Task Write(MessagingConfigResource resource, string phase, string action, MessagingConfigSnapshot? current, string? guard, Action dispatching, CancellationToken token)
		{
			token.ThrowIfCancellationRequested();
			dispatching();
			Writes++;
			if (Mode == WriteMode.Rejected)
				throw new RejectedWrite();
			resources[resource.Target.Key()] = new(resource, "revision-" + Writes, "identity");
			if (Mode == WriteMode.LostAcknowledgement)
				throw new TimeoutException();
			if (Mode == WriteMode.VerificationFailed)
				failRead = true;
			return Task.CompletedTask;
		}
	}
}
