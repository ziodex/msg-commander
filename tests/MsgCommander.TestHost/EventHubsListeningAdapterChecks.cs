using System.Text.Json;
using MsgCommander.Host;
static class EventHubsListeningAdapterChecks
{
	private sealed class Factory : IEventHubsGatewayFactory
	{
		public FixtureEventHubsGateway? Gateway;
		public Task<IEventHubsGateway> ConnectAsync(ConnectionProfile profile, EventHubsManagementContext? context, Func<DeviceCodeEvent, Task> code, CancellationToken token)
		{
			Gateway = new(profile, context, code);
			return Task.FromResult<IEventHubsGateway>(Gateway);
		}
	}
	public static async Task<int> Run()
	{
		var factory = new Factory();
		await using var workspace = new EventHubsWorkspace(factory);
		var profile = new ConnectionProfile(Guid.NewGuid().ToString(), "Fixture", "event-hubs", "fixture.servicebus.windows.net", "sas", "", "", "offline");
		var connected = (EventHubsConnection)(await workspace.ExecuteAsync("eh.connect", JsonSerializer.SerializeToElement(new
		{
			operationId = Guid.NewGuid().ToString(),
			profile,
			hubName = "listen-many",
			management = (object?)null
		}), _ => Task.CompletedTask, default))!;
		var result = (EventListenResult)(await workspace.ExecuteAsync("eh.listen", JsonSerializer.SerializeToElement(new
		{
			id = Guid.NewGuid().ToString(),
			connectionId = connected.ConnectionId,
			hubName = "listen-many",
			consumerGroup = "$Default",
			start = new
			{
				kind = "earliest"
			},
			concurrency = 2,
			maxEvents = 24,
			maxSeconds = 10,
			acknowledged = true
		}), _ => Task.CompletedTask, default))!;
		if (result.Received != 24 || factory.Gateway!.PeakReaders != 2 || factory.Gateway.OpenReaders != 0)
			throw new Exception("Receiver concurrency/cleanup invariant failed");
		var options = AzureEventHubsGateway.ReaderOptions();
		if (options.OwnerLevel is not null)
			throw new Exception("Listener must not claim exclusive ownership");
		Console.WriteLine("Event Hubs listener concurrency and cleanup checks passed");
		return 0;
	}
}
