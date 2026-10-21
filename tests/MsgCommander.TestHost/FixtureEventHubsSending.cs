using Azure.Messaging.EventHubs;
using MsgCommander.Host;

sealed partial class FixtureEventHubsGateway
{
	private readonly Dictionary<(string Hub, string Partition), List<EventData>> published = [];
	public IEventHubSender OpenSender(string hubName) => new Sender(this, hubName);
	private void Publish(string hub, EventRouting routing, IReadOnlyList<OutgoingEvent> batch)
	{
		var partition = routing.Kind == "partition" ? routing.Value! : "0";
		if (!published.TryGetValue((hub, partition), out var events))
			published[(hub, partition)] = events = [];
		foreach (var data in batch)
		{
			var seq = events.Count;
			var copy = EventHubsModelFactory.EventData(new BinaryData(data.EventBody.ToMemory()), new Dictionary<string, object>(data.Properties), new Dictionary<string, object>(), routing.Kind == "key" ? routing.Value : null!, seq, seq.ToString(), Time.AddMilliseconds(seq));
			copy.MessageId = data.MessageId;
			copy.ContentType = data.ContentType;
			copy.CorrelationId = data.CorrelationId;
			events.Add(copy);
		}
	}
	sealed class Sender(FixtureEventHubsGateway gateway, string hub) : IEventHubSender
	{
		public int Sends;
		public async Task<IEventHubBatch> CreateBatchAsync(EventRouting routing, CancellationToken cancellation)
		{
			if (hub == "send-preflight-slow")
				await Task.Delay(10000, cancellation);
			if (hub == "send-denied")
				throw new UnauthorizedAccessException("SECRET no Send claim");
			if (hub == "send-reauth" && gateway.code is not null)
				await gateway.code(new("OFFLINE-SEND", MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow.AddMinutes(5))));
			return new Batch(this, gateway, hub, routing);
		}
		public ValueTask DisposeAsync() => hub == "send-cleanup" ? ValueTask.FromException(new IOException("SECRET producer close")) : ValueTask.CompletedTask;
	}
	sealed class Batch(Sender sender, FixtureEventHubsGateway gateway, string hub, EventRouting routing) : IEventHubBatch
	{
		private readonly List<OutgoingEvent> items = [];
		public int Count => items.Count;
		public bool TryAdd(OutgoingEvent data)
		{
			if (hub == "send-oversized" && data.EventBody.ToString().Contains("oversized"))
				return false;
			if (hub == "send-split" && items.Count == 2)
				return false;
			items.Add(data);
			return true;
		}
		public async Task SendAsync(Action dispatching, CancellationToken cancellation)
		{
			cancellation.ThrowIfCancellationRequested();
			dispatching();
			sender.Sends++;
			if (hub == "send-reject")
				throw new UnauthorizedAccessException("SECRET rejected send");
			if (hub == "send-slow")
				await Task.Delay(10000, cancellation);
			if (hub == "send-late")
				await Task.Delay(300);
			if (hub == "send-partial" && sender.Sends == 2)
				throw new IOException("SECRET interrupted send");
			gateway.Publish(hub, routing, items);
			if (hub == "send-unknown")
				throw new IOException("SECRET acknowledgement lost");
		}
		public void Dispose()
		{
		}
	}
}
