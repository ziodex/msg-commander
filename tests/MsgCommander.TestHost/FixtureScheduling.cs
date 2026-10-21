using Azure.Messaging.ServiceBus;
using MsgCommander.Host;

sealed partial class FixtureGateway
{
	public async Task<IReadOnlyList<long>> SendBatchAsync(EntityTarget target, IReadOnlyList<OutgoingMessage> messages, DateTimeOffset? scheduled, Action dispatching, CancellationToken cancellation)
	{
		var outgoing = messages.Select(AzureOutgoingMessage.ToSdk).ToArray();
		if (outgoing.Any(message => message.MessageId == "slow-preflight"))
			await Task.Delay(10000, cancellation);
		cancellation.ThrowIfCancellationRequested();
		if (scheduled is { } time)
			BatchSending.RequireFuture(time);
		dispatching();
		if (outgoing.Any(message => message.MessageId == "reject-batch"))
			throw new UnauthorizedAccessException("SECRET denied");
		List<long> sequences = [];
		foreach (var message in outgoing)
		{
			if (scheduled is { } enqueueTime)
			{
				message.ScheduledEnqueueTime = enqueueTime;
				var sequence = nextSequence++;
				sequences.Add(sequence);
				Bucket(target, false).Add(new(message, sequence, "scheduled"));
			}
			else
				Publish(target, message);
		}
		if (outgoing.Any(message => message.MessageId == "commit-late"))
			await Task.Delay(150);
		if (outgoing.Any(message => message.MessageId == "unknown-batch"))
			throw new ServiceBusException("SECRET acknowledgement lost", ServiceBusFailureReason.ServiceCommunicationProblem);
		return sequences;
	}
	public Task CancelScheduledAsync(EntityTarget target, IReadOnlyList<long> sequences, Action dispatching, CancellationToken cancellation)
	{
		cancellation.ThrowIfCancellationRequested();
		dispatching();
		Bucket(target, false).RemoveAll(message => message.State == "scheduled" && sequences.Contains(message.Sequence));
		if (target.Name == "cancel-unknown")
			throw new ServiceBusException("SECRET acknowledgement lost", ServiceBusFailureReason.ServiceCommunicationProblem);
		return Task.CompletedTask;
	}
}
