using Azure.Messaging.ServiceBus;
using MsgCommander.Host;

sealed partial class FixtureGateway
{
	public async Task<IMessageReceiver> OpenNextSessionAsync(EntityTarget target, CancellationToken cancellation)
	{
		cancellation.ThrowIfCancellationRequested();
		if (target.Name == "session-test-slow-accept")
			await Task.Delay(10000, cancellation);
		if (target.Name == "session-test-denied-accept")
			throw new UnauthorizedAccessException("SECRET denied");
		lock (sessionAcceptSync)
		{
			SeedSessions(target);
			var next = Bucket(target, true).FirstOrDefault(item => item.State == "active" && item.Message.SessionId is not null &&
				item.Message.SessionId != "locked-session" &&
				(!sessionOwners.TryGetValue((target, item.Message.SessionId), out var receiver) || receiver.SessionLockedUntil <= DateTimeOffset.UtcNow));
			if (next is null)
				throw new ServiceBusException("SECRET no available session", ServiceBusFailureReason.ServiceTimeout);
			return OpenReceiverAsync(target, "active", next.Message.SessionId, cancellation).GetAwaiter().GetResult();
		}
	}
}
