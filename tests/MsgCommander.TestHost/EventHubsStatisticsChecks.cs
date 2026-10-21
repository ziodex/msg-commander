using System.Text.Json;
using Azure.Messaging.EventHubs.Consumer;
using MsgCommander.Host;

static class EventHubsStatisticsChecks
{
	public static async Task Run()
	{
		int assertions = 0;
		void Check(bool value, string label)
		{
			assertions++;
			if (!value)
				throw new Exception(label);
		}
		var gateway = new Gateway();
		await using var workspace = new EventHubsWorkspace(new Factory(gateway));
		var profile = new ConnectionProfile(Guid.NewGuid().ToString(), "Offline", "event-hubs", "fixture.servicebus.windows.net", "sas", "", "", "offline");
		async Task<object?> Call(string method, object input, CancellationToken token = default) => await workspace.ExecuteAsync(method, JsonSerializer.SerializeToElement(input, new JsonSerializerOptions(JsonSerializerDefaults.Web)), _ => Task.CompletedTask, token);
		var connection = (EventHubsConnection)(await Call("eh.connect", new
		{
			operationId = Guid.NewGuid(),
			profile,
			hubName = "telemetry",
			management = (object?)null,
			access = "send"
		}))!;
		object Input() => new
		{
			id = Guid.NewGuid(),
			connectionId = connection.ConnectionId,
			hubName = "telemetry"
		};
		var snapshot = (EventHubStatistics)(await Call("eh.statistics", Input()))!;
		Check(gateway.Peak is > 1 and <= 8 && gateway.Active == 0, "Metadata concurrency bounded at eight with no unfinished calls");
		Check(snapshot.Partitions.Count == 32 && snapshot.Partitions.Select(x => x.PartitionId).SequenceEqual(Enumerable.Range(0, 32).Select(x => x.ToString())), "Discovery order preserved across concurrent calls");
		Check(snapshot.Partitions[5].Metadata is null && snapshot.Partitions[5].Error!.Contains("unavailable") && !JsonSerializer.Serialize(snapshot).Contains("SECRET"), "One failed partition produces sanitized partial result");
		Check(snapshot.Partitions[0].Metadata!.BeginningSequence == "9007199254740993", "Exact metadata remains intact");
		Check(gateway.Readers == 0 && gateway.SendOnly, "Statistics use send-only metadata without opening any reader");
		gateway.Slow = true;
		using var stop = new CancellationTokenSource(30);
		try
		{
			await Call("eh.statistics", Input(), stop.Token);
			throw new Exception("Cancellation ignored");
		}
		catch (OperationCanceledException) { }
		Check(gateway.Active == 0, "Cancellation waits for all metadata calls to close");
		gateway.Slow = false;
		Check(((EventHubStatistics)(await Call("eh.statistics", Input()))!).Partitions.Count == 32, "Cancelled refresh does not poison future reads");
		gateway.Duplicate = true;
		try
		{
			await Call("eh.statistics", Input());
			throw new Exception("Duplicate partition accepted");
		}
		catch (OperationException) { }
		Check(gateway.Active == 0, "Invalid discovery rejected before any partition request");
		Console.WriteLine($"Event Hubs statistics checks passed ({assertions} assertions)");
	}
	sealed class Factory(Gateway gateway) : IEventHubsGatewayFactory
	{
		public Task<IEventHubsGateway> ConnectAsync(ConnectionProfile profile, EventHubsManagementContext? management, Func<DeviceCodeEvent, Task> code, CancellationToken token) => Task.FromResult<IEventHubsGateway>(gateway);
	}
	sealed class Gateway : IEventHubsGateway
	{
		public int Active, Peak, Readers;
		public bool Slow, Duplicate, SendOnly = true;
		public bool CanBrowse => false;
		public IEventHubsAdministration? Administration => null;
		public Task<EventHubInfo> GetHubAsync(string name, CancellationToken token, bool forSending = false)
		{
			SendOnly &= forSending;
			return Task.FromResult(new EventHubInfo(name, Duplicate ? ["0", "0"] : Enumerable.Range(0, 32).Select(x => x.ToString()).ToArray(), "2026-10-11T10:00:00Z"));
		}
		public async Task<EventHubPartition> GetPartitionAsync(string name, string id, CancellationToken token, bool forSending = false)
		{
			SendOnly &= forSending;
			var count = Interlocked.Increment(ref Active);
			int peak;
			do
			{
				peak = Peak;
				if (peak >= count)
					break;
			} while (Interlocked.CompareExchange(ref Peak, count, peak) != peak);
			try
			{
				await Task.Delay(Slow ? 10000 : 5, token);
				if (id == "5")
					throw new IOException("SECRET metadata failure");
				return new(name, id, false, "9007199254740993", "9007199254740995", "opaque:offset", "2026-10-11T10:00:00Z");
			}
			finally { Interlocked.Decrement(ref Active); }
		}
		public IEventHubReader OpenReader(string name, string group, string partition, StreamPosition position)
		{
			Readers++;
			throw new NotSupportedException();
		}
		public IEventHubSender OpenSender(string name) => throw new NotSupportedException();
		public Task<EventHubsPage> ListAsync(string kind, string name, string? cursor, CancellationToken token) => throw new NotSupportedException();
		public ValueTask DisposeAsync() => ValueTask.CompletedTask;
	}
}
