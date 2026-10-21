using System.Net;
using System.Text.Json;
using System.Xml.Linq;
using Azure.Core.Pipeline;
using Azure.Messaging.ServiceBus;
using Azure.Messaging.ServiceBus.Administration;
using MsgCommander.Host;
using static MsgCommander.Application.ServiceBus.Entities.EntityManagement;

static class EntityAdapterChecks
{
	static void Assert(bool value, string label)
	{
		if (!value)
			throw new Exception(label);
	}
	public static async Task<int> Run()
	{
		const string connection = "Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Fixture;SharedAccessKey=ZmFrZQ==";
		var primaryKey = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("SECRET_PRIMARY".PadRight(32, 'A')));
		var secondaryKey = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes("SECRET_SECONDARY".PadRight(32, 'B')));
		using var wire = new ManagementWire();
		using var http = new HttpClient(wire);
		var admin = new ServiceBusAdministrationClient(connection, new ServiceBusAdministrationClientOptions { Transport = new HttpClientTransport(http), Retry = { MaxRetries = 0 } });
		await using var gateway = new AzureServiceBusGateway(admin, new ServiceBusClient(connection));
		EntityTarget[] targets = [new("queue", "orders"), new("topic", "events"), new("subscription", "billing", "events")];
		var dispatches = 0;
		foreach (var target in targets)
		{
			var settings = FixtureGateway.DefaultSettings(target.Kind) with
			{
				UserMetadata = "created",
				AutoDeleteOnIdle = "00:10:00",
				DefaultMessageTimeToLive = "2.00:00:00",
				EnableBatchedOperations = false
			};
			if (target.Kind != "subscription")
				settings = settings with
				{
					RequiresDuplicateDetection = true,
					EnablePartitioning = true,
					DuplicateDetectionHistoryTimeWindow = "00:02:00",
					MaxSizeInMegabytes = 2048,
					MaxMessageSizeInKilobytes = 1024
				};
			if (target.Kind != "topic")
				settings = settings with
				{
					RequiresSession = true,
					LockDuration = "00:00:45",
					MaxDeliveryCount = 15,
					DeadLetteringOnMessageExpiration = true,
					ForwardDeadLetteredMessagesTo = "archive"
				};
			if (target.Kind == "topic")
				settings = settings with
				{
					SupportOrdering = true
				};
			await gateway.ChangeEntityAsync("create", target, settings, null, () => dispatches++, default);
			var created = await gateway.GetEntityConfigurationAsync(target, default);
			Assert(created.Settings == settings, "Every create field round-trips through real SDK XML: " + target.Kind);
			var document = wire.Entities[Path(target)];
			if (target.Kind == "subscription")
				Assert(document.ToString().Contains("TrueFilter"), "Creation specifies the SDK match-all default rule");
			var description = document.Descendants().First(e => e.Name.LocalName.EndsWith("Description", StringComparison.Ordinal));
			description.Add(new XElement(description.Name.Namespace + "FutureSetting", "preserve-me"));
		}
		// Seed a real SDK authorization rule, then verify the application updates that same fetched model.
		var queue = (await admin.GetQueueAsync("orders")).Value;
		queue.AuthorizationRules.Add(new SharedAccessAuthorizationRule("fixture-rule", primaryKey, secondaryKey, [AccessRights.Listen]));
		await admin.UpdateQueueAsync(queue);
		foreach (var target in targets)
		{
			var current = await gateway.GetEntityConfigurationAsync(target, default);
			Assert(!JsonSerializer.Serialize(current).Contains(primaryKey), "Keys never enter settings DTO");
			var edited = current.Settings with
			{
				UserMetadata = "edited",
				Status = "Disabled",
				DefaultMessageTimeToLive = "00:30:00",
				AutoDeleteOnIdle = "disabled",
				EnableBatchedOperations = true
			};
			if (target.Kind != "topic")
				edited = edited with
				{
					ForwardTo = "destination",
					MaxDeliveryCount = 21
				};
			await gateway.ChangeEntityAsync("update", target, edited, current.Revision, () => dispatches++, default);
			Assert((await gateway.GetEntityConfigurationAsync(target, default)).Settings == edited, "Editable fields round-trip: " + target.Kind);
			Assert(wire.Entities[Path(target)].ToString().Contains("preserve-me"), "Unknown server properties preserved");
			Assert(wire.LastIfMatch == "*", "SDK uses wildcard If-Match; client revision check is explicitly best effort");
			var puts = wire.Puts;
			try
			{
				await gateway.ChangeEntityAsync("update", target, edited, current.Revision, () => dispatches++, default);
				throw new Exception("Accepted stale revision");
			}
			catch (OperationException e) { Assert(e.Failure == OperationFailure.RevisionConflict, "Stale revision code"); }
			var latest = await gateway.GetEntityConfigurationAsync(target, default);
			var immutable = target.Kind == "topic" ? edited with
			{
				EnablePartitioning = false
			} : edited with
			{
				RequiresSession = false
			};
			try
			{
				await gateway.ChangeEntityAsync("update", target, immutable, latest.Revision, () => dispatches++, default);
				throw new Exception("Accepted immutable setting");
			}
			catch (OperationException) { }
			Assert(wire.Puts == puts, "Rejected stale/immutable edits issue no HTTP PUT");
		}
		Assert(wire.Entities["orders"].ToString().Contains(primaryKey), "Existing authorization rules preserved on update");
		Assert(!wire.Entities["events/Subscriptions/billing"].ToString().Contains("DefaultRuleDescription") && wire.Paths.All(path => !path.Contains("/Rules/")), "Subscription update omits rule changes and never calls rule endpoints");
		foreach (var target in targets.Reverse())
		{
			var current = await gateway.GetEntityConfigurationAsync(target, default);
			await gateway.ChangeEntityAsync("delete", target, null, current.Revision, () => dispatches++, default);
			Assert(!wire.Entities.ContainsKey(Path(target)), "Correct delete path");
		}
		Assert(dispatches == 9, "Exactly one dispatch for each of nine successful mutations");
		var configGateway = new ServiceBusConfigurationGateway(gateway, "fixture.servicebus.windows.net", () => null, () => "sdk-config", new AzureConfigurationFailureClassifier());
		var configWorkspace = new MessagingConfigurationService(configGateway, new AzureConfigurationFailureClassifier());
		var archive = new MessagingConfigArchive(MessagingConfiguration.Format, 1, "service-bus", MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow), "fixture.servicebus.windows.net", [
			new(new("queue","config-imported",null,null),MessagingConfiguration.Value(new{userMetadata="SDK configuration import"}),false,null),
			new(new("topic","config-topic",null,null),MessagingConfiguration.Value(new{userMetadata="SDK topic import"}),false,null)
		], []);
		var id = Guid.NewGuid().ToString();
		var connectionId = Guid.NewGuid().ToString();
		var preview = await configWorkspace.PreviewAsync(new("service-bus", Convert.ToBase64String(MessagingConfiguration.Encode(archive, "json"))), default);
		Assert(preview.Entries.All(e => e.Action == "create" && e.Issue is null), "Real SDK missing entities become create entries");
		var imported = await configWorkspace.ApplyAsync(new(Guid.NewGuid().ToString(), connectionId, "service-bus", preview.ImportId, preview.Entries.Select(e => e.Id).ToArray(), true), "sdk-config-import", _ => Task.CompletedTask, default);
		Assert(imported.Status == "completed" && (await gateway.GetEntityConfigurationAsync(new("queue", "config-imported"), default)).Settings.UserMetadata == "SDK configuration import", "Configuration creation runs through real Service Bus SDK serialization and missing-entity errors");
		Console.WriteLine("Entity adapter checks passed");
		return 0;
	}
	public static async Task<int> RunCopyChecks()
	{
		const string connection = "Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Fixture;SharedAccessKey=ZmFrZQ==";
		using var wire = new ManagementWire();
		using var http = new HttpClient(wire);
		var admin = new ServiceBusAdministrationClient(connection, new ServiceBusAdministrationClientOptions { Transport = new HttpClientTransport(http), Retry = { MaxRetries = 0 } });
		await using var gateway = new AzureServiceBusGateway(admin, new ServiceBusClient(connection));
		foreach (var source in new EntityTarget[] { new("queue", "original"), new("topic", "events"), new("subscription", "billing", "events") })
		{
			var settings = FixtureGateway.DefaultSettings(source.Kind) with
			{
				UserMetadata = "copied metadata",
				DefaultMessageTimeToLive = "2.00:00:00",
				AutoDeleteOnIdle = "00:15:00",
				EnableBatchedOperations = false
			};
			if (source.Kind != "topic")
				settings = settings with
				{
					RequiresSession = true,
					LockDuration = "00:00:45",
					MaxDeliveryCount = 20,
					ForwardDeadLetteredMessagesTo = "archive"
				};
			if (source.Kind != "subscription")
				settings = settings with
				{
					RequiresDuplicateDetection = true,
					EnablePartitioning = true,
					MaxSizeInMegabytes = 2048,
					MaxMessageSizeInKilobytes = 1024,
					DuplicateDetectionHistoryTimeWindow = "00:03:00"
				};
			await gateway.ChangeEntityAsync("create", source, settings, null, () => { }, default);
			if (source.Kind == "queue")
			{
				var entity = (await admin.GetQueueAsync(source.Name)).Value;
				entity.AuthorizationRules.Add(new SharedAccessAuthorizationRule("sensitive", new string('A', 44), new string('B', 44), [AccessRights.Listen]));
				await admin.UpdateQueueAsync(entity);
			}
			var state = await gateway.GetEntityCopyStateAsync(source, default);
			Assert(state.Configuration.Settings == settings, "All supported settings are available for copying");
			Assert(!JsonSerializer.Serialize(state).Contains("sensitive"), "SAS policies never enter the copy snapshot");
			var destination = source with
			{
				Name = source.Name + "-copy"
			};
			Assert(!await gateway.EntityExistsAsync(destination, default), "Missing destination is detected");
			await gateway.CreateEntityCopyAsync(destination, state.Configuration.Settings with
			{
				Status = "Disabled"
			}, "$CommanderCopy_test", () => { }, default);
			Assert(await gateway.EntityExistsAsync(destination, default), "Created destination exists");
			Assert((await gateway.GetEntityCopyStateAsync(destination, default)).Configuration.Settings == settings with
			{
				Status = "Disabled"
			}, "Copied settings serialize without loss");
			var copied = wire.Entities[Path(destination)].ToString();
			Assert(!copied.Contains("sensitive"), "Queue copy excludes SAS credentials");
			if (source.Kind == "subscription")
				Assert(copied.Contains("FalseFilter") && copied.Contains("$CommanderCopy_test") && !copied.Contains("TrueFilter"), "Subscription starts atomically with false guard");
			var description = wire.Entities[Path(source)].Descendants().First(e => e.Name.LocalName.EndsWith("Description", StringComparison.Ordinal));
			if (source.Kind == "queue")
			{
				var ordering = new XElement(description.Name.Namespace + "SupportOrdering", "false");
				description.Add(ordering);
				await gateway.GetEntityCopyStateAsync(source, default);
				ordering.Value = "true";
				try
				{
					await gateway.GetEntityCopyStateAsync(source, default);
					throw new Exception("Dropped internal ordering");
				}
				catch (OperationException error) { Assert(error.Failure == OperationFailure.UnsupportedOperation, "Non-default internal ordering blocks copy"); }
				ordering.Remove();
				var express = description.Elements().Single(e => e.Name.LocalName == "EnableExpress");
				express.Value = "true";
				try
				{
					await gateway.GetEntityCopyStateAsync(source, default);
					throw new Exception("Dropped express setting");
				}
				catch (OperationException error) { Assert(error.Failure == OperationFailure.UnsupportedOperation, "Non-default internal flags block copy"); }
				express.Value = "false";
			}
			if (source.Kind == "subscription")
			{
				var affinity = new XElement(description.Name.Namespace + "IsClientAffine", "false");
				description.Add(affinity);
				await gateway.GetEntityCopyStateAsync(source, default);
				foreach (var unsupported in new[] { "true", "unknown" })
				{
					affinity.Value = unsupported;
					try
					{
						await gateway.GetEntityCopyStateAsync(source, default);
						throw new Exception("Dropped subscription affinity");
					}
					catch (OperationException error) { Assert(error.Failure == OperationFailure.UnsupportedOperation, "Active or unrecognized subscription affinity blocks copy"); }
				}
				affinity.Remove();
			}
			description.Add(new XElement(description.Name.Namespace + "UnknownSetting", "do-not-drop"));
			var puts = wire.Puts;
			try
			{
				await gateway.GetEntityCopyStateAsync(source, default);
				throw new Exception("Copied unknown setting");
			}
			catch (OperationException error) { Assert(error.Failure == OperationFailure.UnsupportedOperation, "Unknown settings block preview"); }
			Assert(wire.Puts == puts, "Unsupported snapshot causes no writes");
		}
		Console.WriteLine("Copy adapter checks passed");
		return 0;
	}
	// Deterministic HTTP transport. The real Azure SDK executes serialization, parsing and routes; no network is reachable.
	sealed class ManagementWire : HttpMessageHandler
	{
		public Dictionary<string, XDocument> Entities { get; } = [];
		public int Puts;
		public List<string> Paths { get; } = [];
		public string? LastIfMatch;
		protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
		{
			var path = Uri.UnescapeDataString(request.RequestUri!.AbsolutePath.Trim('/'));
			Paths.Add(path);
			if (request.Method == HttpMethod.Put)
			{
				Puts++;
				LastIfMatch = request.Headers.IfMatch.FirstOrDefault()?.Tag;
				var document = XDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
				var entry = document.Root!;
				entry.AddFirst(new XElement(entry.Name.Namespace + "title", path.Split('/').Last()));
				Entities[path] = document;
			}
			if (request.Method == HttpMethod.Delete)
			{
				Entities.Remove(path);
				return new(HttpStatusCode.OK);
			}
			return Entities.TryGetValue(path, out var value) ? new(HttpStatusCode.OK)
			{
				Content = new StringContent(value.ToString(), System.Text.Encoding.UTF8, "application/atom+xml")
			} : new(HttpStatusCode.NotFound)
			{
				Content = new StringContent("Missing fixture")
			};
		}
	}
}
