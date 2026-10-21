using System.Transactions;
using Azure.Messaging.ServiceBus;
using MsgCommander.Host;

sealed partial class FixtureGateway
{
	private sealed class Stored(ServiceBusMessage message, long sequence, string state = "active")
	{
		public ServiceBusMessage Message { get; } = message;
		public long Sequence { get; } = sequence;
		public string State { get; set; } = state;
		public string DeferredFrom { get; set; } = "active";
		public FixtureReceiver? Owner
		{
			get; set;
		}
		public DateTimeOffset Expires { get; set; } = DateTimeOffset.UtcNow.AddMinutes(1);
		public DateTimeOffset EnqueuedTime
		{
			get;
		} = message.ApplicationProperties.TryGetValue("fixture-enqueued-time", out var timestamp)
			? DateTimeOffset.Parse((string)timestamp, System.Globalization.CultureInfo.InvariantCulture) : DateTimeOffset.UtcNow;
	}
	// Snapshot enumeration permits the background listener to receive/complete while foreground reads or sends run.
	private sealed class StoredList : IEnumerable<Stored>
	{
		private readonly List<Stored> items = [];
		public void Add(Stored item)
		{
			lock (items)
				items.Add(item);
		}
		public bool Remove(Stored item)
		{
			lock (items)
				return items.Remove(item);
		}
		public int RemoveAll(Predicate<Stored> predicate)
		{
			lock (items)
				return items.RemoveAll(predicate);
		}
		public IEnumerator<Stored> GetEnumerator()
		{
			lock (items)
				return ((IEnumerable<Stored>)items.ToArray()).GetEnumerator();
		}
		System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
	}
	private readonly System.Collections.Concurrent.ConcurrentDictionary<string, StoredList> messages = new();
	private readonly HashSet<EntityTarget> transferSeeded = [];
	private static bool MatchesSubqueue(Stored item, string subQueue) => item.State == "deferred"
		? item.DeferredFrom == subQueue : subQueue == "active" ? item.State is "active" or "scheduled" : item.State == subQueue;
	private void SeedTransfer(EntityTarget target)
	{
		if (!transferSeeded.Add(target))
			return;
		var list = Bucket(target, true);
		if (target.Name == "empty")
			return;
		var message = new ServiceBusMessage(new BinaryData(new byte[] { 0, 255, 65 }))
		{
			MessageId = target.Name == "transfer-unknown" ? "unknown-complete" : "transfer-001",
			Subject = "Forwarding failed",
			SessionId = target.Name is "sessions" or "audit" ? "session-001" : null
		};
		message.ApplicationProperties["DeadLetterReason"] = "MaxTransferHopCountExceeded";
		message.ApplicationProperties["DeadLetterErrorDescription"] = "Forwarding destination unavailable in fixture";
		message.ApplicationProperties["exact"] = long.MaxValue;
		list.Add(new(message, nextSequence++, "transfer-dead-letter"));
	}
	private long nextSequence = 9007199254741000;
	private static string Key(EntityTarget target) => target.Kind + ":" + target.TopicName + ":" + target.Name;
	private StoredList Bucket(EntityTarget target, bool seed)
	{
		lock (sessionAcceptSync)
		{
			if (messages.TryGetValue(Key(target), out var list))
				return list;
			list = [];
			messages[Key(target)] = list;
			if (seed && target.Name != "empty")
			{
				foreach (var (id, state) in new[] { ("received-001", "active"), ("received-002", "active"), ("dead-receive-001", "dead-letter") })
				{
					var message = new ServiceBusMessage(new BinaryData(new byte[] { 0, 255, 65 })) { MessageId = id, Subject = "Fixture delivery", ContentType = "application/octet-stream", SessionId = target.Name is "sessions" or "audit" ? "session-001" : null, TimeToLive = TimeSpan.FromHours(1) };
					message.ApplicationProperties["exact"] = long.MaxValue;
					if (state == "dead-letter")
					{
						message.ApplicationProperties["DeadLetterReason"] = "ValidationFailed";
						message.ApplicationProperties["DeadLetterErrorDescription"] = "Bad fixture";
					}
					list.Add(new(message, nextSequence++, state));
				}
			}
			return list;
		}
	}
	private static ReceivedMessage Project(Stored value) => AzureReceivedMessage.Snapshot(ServiceBusModelFactory.ServiceBusReceivedMessage(
		body: value.Message.MessageId == "listener-oversized" ? new BinaryData(new byte[17 * 1024 * 1024]) : value.Message.Body, messageId: value.Message.MessageId, subject: value.Message.Subject, contentType: value.Message.ContentType,
		sessionId: value.Message.SessionId, correlationId: value.Message.CorrelationId, replyTo: value.Message.ReplyTo, replyToSessionId: value.Message.ReplyToSessionId,
		to: value.Message.To, partitionKey: value.Message.PartitionKey, timeToLive: value.Message.TimeToLive, sequenceNumber: value.Sequence,
		enqueuedSequenceNumber: value.Sequence, enqueuedTime: value.EnqueuedTime, lockedUntil: value.Expires, lockTokenGuid: Guid.NewGuid(),
		scheduledEnqueueTime: value.Message.ScheduledEnqueueTime, properties: new Dictionary<string, object>(value.Message.ApplicationProperties), deliveryCount: 1, serviceBusMessageState: value.State == "scheduled" ? ServiceBusMessageState.Scheduled : value.State == "deferred" ? ServiceBusMessageState.Deferred : ServiceBusMessageState.Active));
	private bool TryFixturePeek(EntityTarget target, string subQueue, long from, out ReceivedMessage? value)
	{
		value = null;
		if (!messages.TryGetValue(Key(target), out var list))
			return false;
		var next = list.FirstOrDefault(item => MatchesSubqueue(item, subQueue) && item.Sequence >= from);
		value = next is null ? null : Project(next);
		return true;
	}
	private void Publish(EntityTarget target, ServiceBusMessage message)
	{
		lock (sessionAcceptSync)
		{
			var state = message.ApplicationProperties.TryGetValue("fixture-subqueue", out var requested) && requested is string scope && scope is "dead-letter" or "transfer-dead-letter" or "deferred" or "scheduled" ? scope : "active";
			if (target.Kind == "topic")
				foreach (var subscription in new[] { "billing", "audit" })
					Bucket(new("subscription", subscription, target.Name), false).Add(new(message, nextSequence++, state));
			else
				Bucket(target, false).Add(new(message, nextSequence++, target.Name == "resend-feedback" ? "dead-letter" : state));
		}
	}
	public ITestMessageSender OpenTestSender(EntityTarget target) => new TestSender(this, target);
	private sealed class TestSender(FixtureGateway owner, EntityTarget target) : ITestMessageSender
	{
		public async Task SendBatchAsync(IReadOnlyList<TestJobMessage> input, Action<int, int> dispatching,
			Action<int, int, double> acknowledged, CancellationToken cancellation)
		{
			IReadOnlyList<ServiceBusMessage> messages = input.Select(MsgCommander.Infrastructure.ServiceBus.TestJobs.AzureTestMessageSender.ToSdkMessage).ToArray();
			if (target.Name == "test-preflight-fail")
				throw new OperationException(OperationFailure.InvalidInput, "Test message exceeds size limit.");
			cancellation.ThrowIfCancellationRequested();
			dispatching(0, messages.Count);
			if (target.Name.StartsWith("test-failure-", StringComparison.Ordinal))
				throw new ServiceBusException("SECRET endpoint details", target.Name switch
				{
					"test-failure-busy" => ServiceBusFailureReason.ServiceBusy,
					"test-failure-timeout" => ServiceBusFailureReason.ServiceTimeout,
					"test-failure-quota" => ServiceBusFailureReason.QuotaExceeded,
					_ => ServiceBusFailureReason.ServiceCommunicationProblem
				});
			var started = System.Diagnostics.Stopwatch.GetTimestamp();
			if (target.Name == "test-concurrent")
				await Task.Delay(30, cancellation);
			if (target.Name == "test-concurrent-unknown")
			{
				await Task.Delay(100); // Every worker is dispatched before the first lost acknowledgement.
				foreach (var message in messages)
					owner.Publish(target, message);
				throw new ServiceBusException("SECRET acknowledgement lost", ServiceBusFailureReason.ServiceCommunicationProblem);
			}
			foreach (var message in messages)
				await owner.SendAsync(target, AzureOutgoingMessage.FromSdk(message), cancellation);
			acknowledged(0, messages.Count, System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalMilliseconds);
		}
		public ValueTask DisposeAsync() => target.Name == "test-sender-cleanup-fail"
			? ValueTask.FromException(new IOException("SECRET cleanup")) : ValueTask.CompletedTask;
	}
	public async Task SendAsync(EntityTarget target, OutgoingMessage outgoing, CancellationToken cancellation)
	{
		var message = AzureOutgoingMessage.ToSdk(outgoing);
		if (target.Name == "resend-reject-send")
			throw new UnauthorizedAccessException("SECRET denied");
		if (target.Name == "resend-slow-send")
			await Task.Delay(10000, cancellation);
		if (message.MessageId == "reject-send")
			throw new UnauthorizedAccessException("SECRET denied");
		if (message.MessageId == "slow-send")
			await Task.Delay(10000, cancellation);
		Publish(target, message);
		if (target.Name == "resend-commit-late")
			await Task.Delay(150);
		if (target.Name == "resend-unknown-send")
			throw new ServiceBusException("SECRET acknowledgement lost", ServiceBusFailureReason.ServiceCommunicationProblem);
		if (message.MessageId == "commit-late")
			await Task.Delay(150); // Simulates a broker acknowledgement winning a cancellation race.
		if (message.MessageId == "unknown-send")
			throw new ServiceBusException("SECRET acknowledgement lost", ServiceBusFailureReason.ServiceCommunicationProblem);
	}
	public Task<IMessageReceiver> OpenReceiverAsync(EntityTarget target, string subQueue, string sessionId, CancellationToken cancellation)
	{
		lock (sessionAcceptSync)
		{
			if (target.Name is "purge-denied" or "listener-denied")
				throw new UnauthorizedAccessException("SECRET purge denied");
			if (subQueue == "active" && target.Name is "sessions" or "audit" && string.IsNullOrEmpty(sessionId))
				throw new OperationException(OperationFailure.InvalidInput, "Session ID required.");
			if (subQueue == "active" && sessionId.Length > 0)
			{
				if (sessionId == "locked-session" || (sessionOwners.TryGetValue((target, sessionId), out var owner) && owner.SessionLockedUntil > DateTimeOffset.UtcNow))
					throw new ServiceBusException("SECRET session owned", ServiceBusFailureReason.SessionCannotBeLocked);
				SeedSessions(target);
			}
			if (subQueue == "transfer-dead-letter")
				SeedTransfer(target);
			var receiver = new FixtureReceiver(this, target, subQueue, sessionId);
			if (receiver.SessionId is not null)
				sessionOwners[(target, sessionId)] = receiver;
			return Task.FromResult<IMessageReceiver>(receiver);
		}
	}
	private sealed partial class FixtureReceiver(FixtureGateway gateway, EntityTarget target, string subQueue, string sessionId) : IMessageReceiver
	{
		private readonly StoredList list = gateway.Bucket(target, true);
		public async Task<IReadOnlyList<ReceivedMessage>> ReceiveAsync(int count, TimeSpan wait, CancellationToken cancellation)
		{
			if (SessionId is not null)
				CheckSession();
			if (sessionId == "multi-slow-receive")
				await Task.Delay(10000, cancellation);
			if (target.Name is "slow" or "resend-slow-receive" || (target.Name == "partial" && list.Any(item => item.Owner == this)))
				await Task.Delay(10000, cancellation);
			Stored[] found;
			lock (gateway.sessionAcceptSync)
			{
				found = list.Where(item => item.State == subQueue && (item.Owner is null || item.Expires <= DateTimeOffset.UtcNow) && (subQueue != "active" || string.IsNullOrEmpty(sessionId) || item.Message.SessionId == sessionId)).Take(count).ToArray();
				foreach (var item in found)
				{
					item.Owner = this;
					item.Expires = item.Message.MessageId.StartsWith("listener-renew", StringComparison.Ordinal) ? DateTimeOffset.UtcNow.AddSeconds(5) : DateTimeOffset.UtcNow.AddMinutes(1);
				}
			}
			if (found.FirstOrDefault()?.Message.MessageId == "purge-wait-receive")
				await Task.Delay(10000, cancellation);
			if (found.FirstOrDefault()?.Message.MessageId.StartsWith("purge-slow", StringComparison.Ordinal) == true)
				await Task.Delay(350, cancellation);
			if (target.Name == "test-receive-late")
				await Task.Delay(150);
			if (target.Name == "cutoff-redelivery")
				foreach (var item in found)
					item.Expires = DateTimeOffset.UtcNow.AddSeconds(-1);
			return found.Select(Project).ToArray();
		}
		public DateTimeOffset LockedUntil(ReceivedMessage message) => SessionLockedUntil ?? (list.FirstOrDefault(item => item.Sequence == message.SequenceNumber)?.Expires ?? message.LockedUntil);
		public Task<ReceivedMessage> ReceiveDeferredAsync(long sequence, CancellationToken cancellation)
		{
			var value = list.FirstOrDefault(item => item.Sequence == sequence && item.State == "deferred" && item.DeferredFrom == subQueue && (item.Owner is null || item.Expires <= DateTimeOffset.UtcNow) && (string.IsNullOrEmpty(sessionId) || item.Message.SessionId == sessionId));
			if (value is null)
				throw new ServiceBusException("SECRET not deferred", ServiceBusFailureReason.MessageNotFound);
			value.Owner = this;
			value.Expires = DateTimeOffset.UtcNow.AddMinutes(1);
			return Task.FromResult(Project(value));
		}
		private Stored Own(ReceivedMessage message)
		{
			if (SessionId is not null)
				CheckSession();
			var value = list.FirstOrDefault(item => item.Sequence == message.SequenceNumber);
			if (value is null || value.Owner != this || value.Expires <= DateTimeOffset.UtcNow || value.Message.MessageId == "lose-lock")
				throw new ServiceBusException("SECRET lock", ServiceBusFailureReason.MessageLockLost);
			return value;
		}
		public async Task SettleAsync(ReceivedMessage message, string action, string reason, string description, CancellationToken cancellation)
		{
			var value = Own(message);
			if (action == "renew" && value.Message.MessageId == "listener-renew-fail")
				throw new ServiceBusException("SECRET lost", ServiceBusFailureReason.MessageLockLost);
			if (action == "complete" && value.Message.MessageId == "purge-reject-complete")
				throw new UnauthorizedAccessException("SECRET rejected");
			if (action == "complete" && value.Message.MessageId == "purge-wait-complete")
				await Task.Delay(10000, cancellation);
			switch (action)
			{
				case "complete":
					list.Remove(value);
					break;
				case "abandon":
					value.Owner = null;
					break;
				case "dead-letter":
					value.State = "dead-letter";
					value.Owner = null;
					value.Message.ApplicationProperties["DeadLetterReason"] = reason;
					value.Message.ApplicationProperties["DeadLetterErrorDescription"] = description;
					break;
				case "defer":
					value.DeferredFrom = subQueue;
					value.State = "deferred";
					value.Owner = null;
					break;
				case "renew":
					value.Expires = DateTimeOffset.UtcNow.AddMinutes(5);
					if (SessionId is not null)
						sessionUntil = value.Expires;
					break;
			}
			if (action == "complete" && value.Message.MessageId == "recovery-complete-unknown")
				throw new ServiceBusException("SECRET completion acknowledgement lost", ServiceBusFailureReason.ServiceCommunicationProblem);
			if (value.Message.MessageId == "unknown-complete")
				throw new ServiceBusException("SECRET acknowledgement lost", ServiceBusFailureReason.ServiceCommunicationProblem);
			if (value.Message.MessageId == "purge-commit-late")
				await Task.Delay(150);
		}
		public async Task ReplayAsync(ReceivedMessage original, EntityTarget destination, OutgoingMessage outgoing, CancellationToken cancellation)
		{
			var value = Own(original);
			if (destination.Name == "reject-replay")
				throw new TransactionAbortedException("SECRET rollback");
			if (destination.Name == "resend-slow-replay")
				await Task.Delay(10000, cancellation);
			gateway.Publish(destination, AzureOutgoingMessage.ToSdk(outgoing));
			list.Remove(value);
			if (destination.Name == "resend-commit-late")
				await Task.Delay(150);
			if (destination.Name == "unknown-replay")
				throw new ServiceBusException("SECRET commit acknowledgement lost", ServiceBusFailureReason.ServiceCommunicationProblem);
		}
		public ValueTask DisposeAsync()
		{
			if (SessionId is not null)
			{
				gateway.sessionOwners.TryRemove(new KeyValuePair<(EntityTarget, string), FixtureReceiver>((target, sessionId), this));
				foreach (var item in list.Where(item => item.Owner == this))
					item.Owner = null;
			}
			if (sessionId == "multi-cleanup-fail")
				throw new IOException("SECRET session dispose");
			if (target.Name == "purge-cleanup-fail")
				throw new IOException("SECRET dispose");
			return ValueTask.CompletedTask;
		}
	}
}
