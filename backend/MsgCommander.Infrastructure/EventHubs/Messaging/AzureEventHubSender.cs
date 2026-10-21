using Azure.Messaging.EventHubs;
using Azure.Messaging.EventHubs.Producer;
namespace MsgCommander.Infrastructure.EventHubs.Messaging;

public sealed class AzureEventHubSender(EventHubProducerClient producer) : IEventHubSender
{
	public async Task<IEventHubBatch> CreateBatchAsync(EventRouting routing, CancellationToken cancellation) => new Batch(producer, await producer.CreateBatchAsync(new CreateBatchOptions
	{
		PartitionId = routing.Kind == "partition" ? routing.Value : null,
		PartitionKey = routing.Kind == "key" ? routing.Value : null
	}, cancellation));
	public ValueTask DisposeAsync() => producer.DisposeAsync();
	private sealed class Batch(EventHubProducerClient producer, EventDataBatch batch) : IEventHubBatch
	{
		public int Count => batch.Count;
		public bool TryAdd(OutgoingEvent data) => batch.TryAdd(AzureOutgoingEvent.ToSdk(data));
		public async Task SendAsync(Action dispatching, CancellationToken cancellation)
		{
			cancellation.ThrowIfCancellationRequested();
			dispatching();
			await producer.SendAsync(batch, cancellation);
		}
		public void Dispose() => batch.Dispose();
	}
}
