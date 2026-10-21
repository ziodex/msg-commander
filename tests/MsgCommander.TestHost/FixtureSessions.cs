using System.Runtime.CompilerServices;
using Azure.Messaging.ServiceBus;
using MsgCommander.Host;

sealed partial class FixtureGateway
{
	private readonly Dictionary<(EntityTarget Target, string Id), BinaryData> sessionStates = [];
	private readonly HashSet<EntityTarget> seededSessions = [];
	private readonly System.Collections.Concurrent.ConcurrentDictionary<(EntityTarget Target, string Id), FixtureReceiver> sessionOwners = new();
	private readonly object sessionAcceptSync = new();
	private void SeedSessions(EntityTarget target)
	{
		lock (sessionAcceptSync)
		{
			if (!seededSessions.Add(target))
				return;
			Bucket(target, true);
			sessionStates[(target, "session-001")] = new BinaryData("{\"checkpoint\":9007199254740993,\"city\":\"Málaga 🚀\"}");
			sessionStates[(target, "state-only")] = new BinaryData("retained with no messages");
			sessionStates[(target, "binary-state")] = new BinaryData(new byte[] { 0, 255, 65 });
			sessionStates[(target, "large-state")] = new BinaryData(new byte[300000]);
			for (var i = 0; i < 101; i++)
				sessionStates[(target, $"state-{i:D3}")] = new BinaryData("checkpoint");
		}
	}
	public async IAsyncEnumerable<string> ListSessionsAsync(EntityTarget target, [EnumeratorCancellation] CancellationToken cancellation)
	{
		if (target.Name == "session-test-denied")
			throw new UnauthorizedAccessException("SECRET sessions");
		if (target.Name == "session-test-slow")
			await Task.Delay(10000, cancellation);
		SeedSessions(target);
		var ids = Bucket(target, false).Where(m => m.State == "active" && m.Message.SessionId is not null).Select(m => m.Message.SessionId)
			.Concat(sessionStates.Keys.Where(k => k.Target == target).Select(k => k.Id)).Distinct().Order(StringComparer.Ordinal).ToArray();
		foreach (var id in ids)
		{
			cancellation.ThrowIfCancellationRequested();
			yield return id;
		}
	}
	private sealed partial class FixtureReceiver
	{
		private DateTimeOffset sessionUntil = sessionId is "listener-renew-session" or "multi-renew-fail" ? DateTimeOffset.UtcNow.AddSeconds(5) : DateTimeOffset.UtcNow.AddMinutes(1);
		public string? SessionId => subQueue != "active" || string.IsNullOrEmpty(sessionId) ? null : sessionId;
		public DateTimeOffset? SessionLockedUntil => SessionId is null ? null : sessionUntil;
		private void CheckSession()
		{
			if (SessionId is null)
				throw new OperationException(OperationFailure.InvalidInput, "Accept a session first.");
			if ((sessionId == "lost-session" || (sessionId == "lose-after-receive" && list.Any(item => item.Owner == this))) || sessionUntil <= DateTimeOffset.UtcNow)
				throw new ServiceBusException("SECRET session lock lost", ServiceBusFailureReason.SessionLockLost);
		}
		public Task<MessageBody?> GetSessionStateAsync(CancellationToken cancellation)
		{
			CheckSession();
			gateway.SeedSessions(target);
			var value = gateway.sessionStates.GetValueOrDefault((target, sessionId));
			return Task.FromResult(value is null ? null : MessageBody.FromBytes(value.ToMemory()));
		}
		public async Task SetSessionStateAsync(MessageBody? state, CancellationToken cancellation)
		{
			CheckSession();
			if (sessionId == "slow-state")
				await Task.Delay(10000, cancellation);
			if (state is null)
				gateway.sessionStates.Remove((target, sessionId));
			else
				gateway.sessionStates[(target, sessionId)] = new BinaryData(state.ToMemory());
			if (sessionId == "unknown-state")
				throw new ServiceBusException("SECRET state ack lost", ServiceBusFailureReason.ServiceCommunicationProblem);
			if (sessionId == "commit-late-state")
				await Task.Delay(150);
		}
		public Task RenewSessionLockAsync(CancellationToken cancellation)
		{
			CheckSession();
			if (sessionId == "multi-renew-fail")
				throw new ServiceBusException("SECRET renewal failed", ServiceBusFailureReason.SessionLockLost);
			sessionUntil = DateTimeOffset.UtcNow.AddMinutes(5);
			if (sessionId == "unknown-renew")
				throw new ServiceBusException("SECRET renew ack", ServiceBusFailureReason.ServiceCommunicationProblem);
			return Task.CompletedTask;
		}
	}
}
