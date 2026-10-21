using System.Net;
using System.Text;
using System.Text.Json;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Consumer;
using Azure.ResourceManager;
using Azure.ResourceManager.EventHubs;
using MsgCommander.Host;

sealed class FixtureEventHubsFactory : IEventHubsGatewayFactory
{
	public async Task<IEventHubsGateway> ConnectAsync(ConnectionProfile profile, EventHubsManagementContext? management, Func<DeviceCodeEvent, Task> code, CancellationToken cancellation)
	{
		if (profile.Namespace != "fixture.servicebus.windows.net")
			throw new OperationException(OperationFailure.InvalidInput, "The offline Event Hubs host only accepts the fixture namespace.");
		if (management?.TenantId == "denied")
			throw new Azure.RequestFailedException(403, "SECRET ARM denial");
		if (management?.TenantId == "slow" || profile.TenantId == "slow")
		{
			await code(new("OFFLINE-EVENTS", MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow.AddMinutes(5))));
			await Task.Delay(10000, cancellation);
		}
		return new FixtureEventHubsGateway(profile, management, code);
	}
}
sealed partial class FixtureEventHubsGateway : IEventHubsGateway
{
	public const string ResourceId = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/fixture-rg/providers/Microsoft.EventHub/namespaces/fixture";
	public static readonly DateTimeOffset Time = DateTimeOffset.Parse("2026-10-11T10:00:00Z");
	private readonly AzureEventHubsGateway management;
	private readonly Func<DeviceCodeEvent, Task>? code;
	private readonly bool iot;
	public EventHubsWire Wire { get; } = new();
	public bool CanBrowse
	{
		get;
	}
	public bool Recreated
	{
		get; set;
	}
	public bool RetentionAdvanced
	{
		get; set;
	}
	public IEventHubsAdministration? Administration => management.Administration;
	public FixtureEventHubsGateway(ConnectionProfile profile, EventHubsManagementContext? context, Func<DeviceCodeEvent, Task>? code = null)
	{
		this.code = code;
		iot = profile.Service == "iot-hub";
		CanBrowse = context is not null;
		Wire.Tier = context?.TenantId switch
		{
			"premium" => "Premium",
			"basic" => "Basic",
			"dedicated" => "Dedicated",
			_ => "Standard"
		};
		Wire.BeforeRequest = async (path, token) => { if (path.Contains("admin-reauth") && code is not null) await code(new("OFFLINE-ADMIN", MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow.AddMinutes(5)))); };
		var arm = new ArmClient(new Credential(), null, new ArmClientOptions { Transport = new HttpClientTransport(new HttpClient(Wire)), Retry = { MaxRetries = 0 } });
		management = new(profile, null, null, CanBrowse ? arm.GetEventHubsNamespaceResource(new ResourceIdentifier(ResourceId)) : null, arm);
	}
	public Task<EventHubsPage> ListAsync(string kind, string hubName, string? continuation, CancellationToken cancellation) => management.ListAsync(kind, hubName, continuation, cancellation);
	public async Task<EventHubInfo> GetHubAsync(string hubName, CancellationToken cancellation, bool forSending = false)
	{
		if (hubName == "connect-slow")
			await Task.Delay(10000, cancellation);
		if (hubName == "send-only" && !forSending)
			throw new UnauthorizedAccessException("SECRET needs send identity");
		if (hubName == "denied")
			throw new UnauthorizedAccessException("SECRET data permission");
		if (hubName == "reauth" && code is not null)
			await code(new("OFFLINE-REFRESH", MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow.AddMinutes(5))));
		return new EventHubInfo(hubName, hubName.StartsWith("listen-") ? Enumerable.Range(0, hubName == "listen-1024" ? 1024 : 8).Select(i => i.ToString()).ToArray() : ["0", "1"], MsgCommander.Application.Common.DisplayValues.Timestamp(Time.AddDays(Recreated ? -2 : -1)));
	}
	public async Task<EventHubPartition> GetPartitionAsync(string hubName, string partitionId, CancellationToken cancellation, bool forSending = false)
	{
		if (hubName == "stats-slow")
			await Task.Delay(10000, cancellation);
		if (hubName == "stats-partial" && partitionId == "1")
			throw new IOException("SECRET partition failure");
		return AzureEventHubsGateway.Project(EventHubsModelFactory.PartitionProperties(hubName, partitionId, partitionId == "1" && !hubName.StartsWith("listen-"), RetentionAdvanced ? 9007199254740995 : 9007199254740993, 9007199254740995, "offset:three", Time.AddSeconds(2)));
	}
	public IEventHubReader OpenReader(string hubName, string consumerGroup, string partitionId, StreamPosition position)
	{
		if (consumerGroup == "denied")
			throw new UnauthorizedAccessException("SECRET group denied");
		var events = published.TryGetValue((hubName, partitionId), out var saved) ? saved.ToArray() : (partitionId == "1" && !hubName.StartsWith("listen-")) || hubName.StartsWith("send-") ? Array.Empty<EventData>() : Events(hubName);
		if (position.Kind == StreamPositionKind.Latest)
			events = [];
		else if (position.Kind == StreamPositionKind.Sequence)
		{
			var seq = long.Parse(position.Value!, System.Globalization.CultureInfo.InvariantCulture);
			events = events.Where(e => e.SequenceNumber > seq || position.Inclusive && e.SequenceNumber == seq).ToArray();
		}
		else if (position.Kind == StreamPositionKind.Time)
		{
			var time = DateTimeOffset.Parse(position.Value!, System.Globalization.CultureInfo.InvariantCulture);
			events = events.Where(e => e.EnqueuedTime >= time).ToArray();
		}
		else if (position.Kind == StreamPositionKind.Offset)
		{
			var index = Array.FindIndex(events, e => e.OffsetString == position.Value);
			events = index < 0 ? hubName == "legacy-expired" ? events : [] : events.Skip(index + (position.Inclusive ? 0 : 1)).ToArray();
		}
		if (iot)
			events = events.Select(e => EventHubsModelFactory.EventData(e.EventBody, e.Properties, new Dictionary<string, object> { ["iothub-connection-device-id"] = "sensor-01", ["iothub-connection-auth-method"] = "{\"scope\":\"device\",\"type\":\"sas\"}", ["iothub-enqueuedtime"] = Time, ["content-type"] = "application/json" }, e.PartitionKey, e.SequenceNumber, e.OffsetString, e.EnqueuedTime)).ToArray();
		return new TrackedReader(this, new Reader(hubName, events));
	}
	private int openReaders, peakReaders;
	public int OpenReaders => openReaders;
	public int PeakReaders => peakReaders;
	sealed class TrackedReader : IEventHubReader
	{
		private readonly FixtureEventHubsGateway owner; private readonly IEventHubReader reader; private bool closed;
		public TrackedReader(FixtureEventHubsGateway owner, IEventHubReader reader)
		{
			this.owner = owner;
			this.reader = reader;
			var count = Interlocked.Increment(ref owner.openReaders);
			int peak;
			do
			{
				peak = owner.peakReaders;
				if (peak >= count)
					break;
			} while (Interlocked.CompareExchange(ref owner.peakReaders, count, peak) != peak);
		}
		public Task<IReadOnlyList<ReceivedEvent>> ReadAsync(TimeSpan wait, CancellationToken token) => reader.ReadAsync(wait, token);
		public async ValueTask DisposeAsync()
		{
			await reader.DisposeAsync();
			if (!closed)
			{
				closed = true;
				Interlocked.Decrement(ref owner.openReaders);
			}
		}
	}
	public static EventData[] Events(string hub)
	{
		EventData Item(BinaryData body, int i) => EventHubsModelFactory.EventData(body,
			new Dictionary<string, object> { ["unsigned"] = ulong.MaxValue, ["binary"] = new byte[] { 0, 255 }, ["label"] = "temperature" },
			new Dictionary<string, object> { ["content-type"] = "application/json" }, "device-1", 9007199254740993 + i, new[] { "offset:one", "offset:two", "offset:three" }[i], Time.AddSeconds(i));
		if (hub == "budget")
			return [Item(new BinaryData(new byte[40 * 1024 * 1024]), 0), Item(new BinaryData(new byte[40 * 1024 * 1024]), 1)];
		if (hub == "large")
			return [Item(new BinaryData(new string('x', 70000)), 0)];
		var first = Item(new BinaryData("{\"temperature\":21,\"sequence\":\"9007199254740993\"}"), 0);
		if (hub == "metadata")
			for (var i = 0; i < 100; i++)
				first.Properties["value-" + i] = new string('x', 3000);
		return [first, Item(new BinaryData(new byte[] { 0, 255, 128, 65 }), 1), Item(new BinaryData("last event"), 2)];
	}
	public ValueTask DisposeAsync() => ValueTask.CompletedTask;
	sealed class Reader(string hub, EventData[] events) : IEventHubReader
	{
		private int cursor;
		public async Task<IReadOnlyList<ReceivedEvent>> ReadAsync(TimeSpan wait, CancellationToken cancellation)
		{
			if ((hub == "fail" || hub == "listen-fail") && cursor == 1)
				throw new IOException("SECRET interrupted receive");
			if (hub == "late")
				await Task.Delay(300);
			else if (hub == "slow")
				await Task.Delay(10000, cancellation);
			else if ((hub == "paced" || hub == "listen-paced"))
				await Task.Delay(500, cancellation);
			if (cursor >= events.Length)
			{
				await Task.Delay(wait, cancellation);
				return [];
			}
			if (hub == "over-batch")
				return events.Select(e => (ReceivedEvent)new AzureReceivedEvent(e)).ToArray();
			return [new AzureReceivedEvent(events[cursor++])];
		}
		public ValueTask DisposeAsync() => (hub == "cleanup" || hub == "listen-cleanup") ? ValueTask.FromException(new IOException("SECRET cleanup failed")) : ValueTask.CompletedTask;
	}
	sealed class Credential : TokenCredential
	{
		public override AccessToken GetToken(TokenRequestContext context, CancellationToken cancellation) => new("offline-token", DateTimeOffset.UtcNow.AddHours(1));
		public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext context, CancellationToken cancellation) => ValueTask.FromResult(GetToken(context, cancellation));
	}
}
