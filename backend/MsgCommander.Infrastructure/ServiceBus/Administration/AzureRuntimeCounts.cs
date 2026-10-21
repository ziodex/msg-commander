using Azure;
using Azure.Messaging.ServiceBus.Administration;
using static MsgCommander.Application.Common.DisplayValues;
using static MsgCommander.Application.ServiceBus.Messages.MessageProjection;

namespace MsgCommander.Infrastructure.ServiceBus;

public sealed partial class AzureServiceBusGateway
{
	// Paged runtime feeds avoid a settings request and runtime request for every entity.
	public Task<RuntimePage> ListRuntimeAsync(string kind, string? topicName, string? continuationToken, CancellationToken cancellation) => kind switch
	{
		"queue" => RuntimePage(admin.GetQueuesRuntimePropertiesAsync(cancellation), continuationToken,
			q => new(new("queue", q.Name), new(Number(q.ActiveMessageCount), Number(q.DeadLetterMessageCount), Number(q.ScheduledMessageCount), Number(q.TransferMessageCount), Number(q.TransferDeadLetterMessageCount), Number(q.TotalMessageCount), Number(q.SizeInBytes))), cancellation),
		"topic" => RuntimePage(admin.GetTopicsRuntimePropertiesAsync(cancellation), continuationToken,
			t => new(new("topic", t.Name), new(Scheduled: Number(t.ScheduledMessageCount), SizeBytes: Number(t.SizeInBytes))), cancellation),
		"subscription" when !string.IsNullOrWhiteSpace(topicName) => RuntimePage(admin.GetSubscriptionsRuntimePropertiesAsync(topicName, cancellation), continuationToken,
			s => new(new("subscription", s.SubscriptionName, topicName), new(Number(s.ActiveMessageCount), Number(s.DeadLetterMessageCount), null, Number(s.TransferMessageCount), Number(s.TransferDeadLetterMessageCount), Number(s.TotalMessageCount))), cancellation),
		_ => throw new OperationException(OperationFailure.InvalidInput, "Choose an entity category; subscriptions need a topic.")
	};
	private static async Task<RuntimePage> RuntimePage<T>(AsyncPageable<T> values, string? token, Func<T, RuntimeEntity> project, CancellationToken cancellation) where T : notnull
	{
		await foreach (var page in values.AsPages(token, 100).WithCancellation(cancellation))
			return new(page.Values.Select(project).ToArray(), page.ContinuationToken, Timestamp(DateTimeOffset.UtcNow));
		return new([], null, Timestamp(DateTimeOffset.UtcNow));
	}
}
