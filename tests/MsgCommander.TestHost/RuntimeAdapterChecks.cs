using System.Runtime.CompilerServices;
using Azure;
using Azure.Messaging.ServiceBus;
using Azure.Messaging.ServiceBus.Administration;
using MsgCommander.Host;

static class RuntimeAdapterChecks
{
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	public static async Task<int> Run()
	{
		var admin = new Admin();
		await using var gateway = new AzureServiceBusGateway(admin, new NoMessages());
		var queues = await gateway.ListRuntimeAsync("queue", null, "resume", default);
		Assert(queues.ContinuationToken == "next" && queues.Items[0].Counts.Active == "9007199254740993" && queues.Items[0].Counts.DeadLetter == "3" && queues.Items[0].Counts.Scheduled == "2" && queues.Items[0].Counts.Transfer == "5" && queues.Items[0].Counts.TransferDeadLetter == "4", "Queue runtime mapping preserves exact counters");
		var topics = await gateway.ListRuntimeAsync("topic", null, "resume", default);
		Assert(topics.Items[0].Counts.Active is null && topics.Items[0].Counts.Scheduled == "7" && topics.Items[0].Counts.Total is null, "Topic owns scheduled messages, not subscription totals");
		var subscriptions = await gateway.ListRuntimeAsync("subscription", "orders/region", "resume", default);
		Assert(subscriptions.Items[0].Target == new EntityTarget("subscription", "billing", "orders/region") && subscriptions.Items[0].Counts.Scheduled is null && subscriptions.Items[0].Counts.TransferDeadLetter == "4", "Subscription scope and fields");
		try
		{
			await gateway.ListRuntimeAsync("subscription", null, null, default);
			throw new Exception("Missing parent accepted");
		}
		catch (OperationException) { }
		Console.WriteLine("Runtime adapter checks passed");
		return 0;
	}
	sealed class Feed<T>(T value) : AsyncPageable<T> where T : notnull
	{
		public override async IAsyncEnumerable<Page<T>> AsPages(string? continuationToken = null, int? pageSizeHint = null)
		{
			Assert(continuationToken == "resume" && pageSizeHint == 100, "Continuation token and bounded page size passed to SDK");
			await Task.Yield();
			yield return Page<T>.FromValues([value], "next", null!);
		}
	}
	sealed class NoMessages : ServiceBusClient
	{
		public override ValueTask DisposeAsync() => ValueTask.CompletedTask;
	}
	sealed class Admin : ServiceBusAdministrationClient
	{
		public override AsyncPageable<QueueRuntimeProperties> GetQueuesRuntimePropertiesAsync(CancellationToken cancellationToken = default) => new Feed<QueueRuntimeProperties>(ServiceBusModelFactory.QueueRuntimeProperties("orders", 9007199254740993, 2, 3, 4, 5, 9007199254741007, 100, default, default, default));
		public override AsyncPageable<TopicRuntimeProperties> GetTopicsRuntimePropertiesAsync(CancellationToken cancellationToken = default) => new Feed<TopicRuntimeProperties>(ServiceBusModelFactory.TopicRuntimeProperties("events", 7, 100, 2, default, default, default));
		public override AsyncPageable<SubscriptionRuntimeProperties> GetSubscriptionsRuntimePropertiesAsync(string topicName, CancellationToken cancellationToken = default)
		{
			Assert(topicName == "orders/region", "Hierarchical topic is preserved for Service Bus SDK");
			return new Feed<SubscriptionRuntimeProperties>(ServiceBusModelFactory.SubscriptionRuntimeProperties(topicName, "billing", 1, 2, 4, 3, 10, default, default, default));
		}
	}
}
