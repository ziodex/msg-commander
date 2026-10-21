using System.Diagnostics;
using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Listeners;
using MsgCommander.Contracts.ServiceBus.Messages;
using static MsgCommander.Application.Common.DisplayValues;
using static MsgCommander.Application.ServiceBus.Messages.MessageProjection;

namespace MsgCommander.Application.ServiceBus.Listeners;

// One worker owns one exclusive session, with one outstanding delivery. Reservations enforce the
// shared receive cap before dispatch; status stays active through every worker's receiver cleanup.
public sealed class MultiSessionListener : IMessageListener
{
	private const int Budget = 16 * 1024 * 1024;
	private sealed class SessionProgress(string sessionId)
	{
		public readonly string SessionId = sessionId;
		public string Status = "receiving", Summary = "Session acquired.";
		public int Received, Completed, Abandoned, DeadLettered, Deferred, Failed, Uncertain, Renewed, Pending;
		public string? LockedUntil;
		public ListenerSession Snapshot() => new(SessionId, Status, Received, Completed, Abandoned, DeadLettered, Deferred, Failed, Uncertain, Renewed, Pending, LockedUntil, Summary);
	}
	private sealed class Worker
	{
		public readonly SemaphoreSlim Io = new(1);
		public IMessageReceiver? Receiver;
		public SessionProgress? Session;
		public Entry? Pending;
		public long LastReceivedMs;
		public bool Accepting;
	}
	private sealed class Entry(Worker worker, ReceivedMessage message, ListenerItem info, int size, long receivedMs)
	{
		public readonly Worker Worker = worker;
		public readonly ReceivedMessage Message = message;
		public ListenerItem Info = info;
		public readonly int Size = size;
		public readonly long ReceivedMs = receivedMs;
	}
	private sealed record Settlement(string Fingerprint, TaskCompletionSource Done);
	private readonly object sync = new();
	private readonly EntityTarget target;
	private readonly string mode;
	private readonly int maxMessages, maxSeconds, maxLockSeconds, concurrency, idleSeconds;
	private readonly IServiceBusMessagingGateway gateway;
	private readonly IMessageFailureClassifier failures;
	private readonly Func<long, string?, string?>? recordDeferred;
	private readonly Worker[] workers;
	private readonly CancellationTokenSource stop = new(), acceptStop = new(), deadline, lifetime;
	private readonly CancellationToken token;
	private readonly Stopwatch clock = Stopwatch.StartNew();
	private readonly List<Entry> history = [];
	private readonly List<SessionProgress> sessions = [];
	private readonly Dictionary<string, Settlement> settlements = [];
	private Task work = Task.CompletedTask;
	private string status = "running", summary = "Waiting for available sessions.";
	private string? deferredReferenceWarning;
	private string? outcome, outcomeSummary;
	private long? endedMs;
	private int reserved, received, completed, abandoned, deadLettered, deferred, failed, uncertain, renewed, retainedBytes, evicted, acquisitions, sessionsEvicted;
	public string Id
	{
		get;
	}
	public string ConnectionId
	{
		get;
	}
	public string Fingerprint { get; init; } = "";
	public bool Active
	{
		get
		{
			lock (sync)
				return status is "running" or "stopping";
		}
	}
	public MultiSessionListener(string id, string connectionId, EntityTarget target, string mode, int maxMessages, int maxSeconds,
		int maxLockSeconds, int concurrency, int idleSeconds, IServiceBusMessagingGateway gateway, IMessageFailureClassifier failures, Func<long, string?, string?>? recordDeferred = null)
	{
		Id = id;
		ConnectionId = connectionId;
		this.target = target;
		this.mode = mode;
		this.maxMessages = maxMessages;
		this.maxSeconds = maxSeconds;
		this.maxLockSeconds = maxLockSeconds;
		this.concurrency = concurrency;
		this.idleSeconds = idleSeconds;
		this.gateway = gateway;
		this.failures = failures;
		this.recordDeferred = recordDeferred;
		workers = Enumerable.Range(0, Math.Min(concurrency, maxMessages)).Select(_ => new Worker()).ToArray();
		deadline = new(TimeSpan.FromSeconds(maxSeconds));
		lifetime = CancellationTokenSource.CreateLinkedTokenSource(stop.Token, deadline.Token);
		token = lifetime.Token;
	}
	public void Start() => work = Task.Run(Run);
	public ListenerState Snapshot()
	{
		lock (sync)
			return new(Id, ConnectionId, target, null, mode, status, received, completed, abandoned, deadLettered, deferred, failed, uncertain,
			renewed, endedMs ?? clock.ElapsedMilliseconds, maxMessages, maxSeconds, maxLockSeconds, retainedBytes, evicted, deferredReferenceWarning is null ? summary : summary + " " + deferredReferenceWarning,
			history.Select(e => e.Info).Reverse().ToArray(), "next-available", concurrency, idleSeconds,
			workers.Count(w => w.Receiver is not null), workers.Count(w => w.Accepting), acquisitions, sessionsEvicted, sessions.Select(s => s.Snapshot()).ToArray());
	}
	public (ReceivedMessage Message, ReadOnlyMemory<byte> Body, MessageSummary Summary)? Inspect(string snapshotId)
	{
		lock (sync)
		{
			var entry = history.FirstOrDefault(e => e.Info.Summary.SnapshotId == snapshotId);
			return entry is null ? null : (entry.Message, entry.Message.Body.ToMemory(), entry.Info.Summary);
		}
	}
	public async Task<ListenerState> Stop()
	{
		lock (sync)
			if (status == "running")
			{
				status = "stopping";
				summary = "Stopping all sessions; awaiting in-flight broker results and receiver cleanup.";
			}
		await stop.CancelAsync();
		await work;
		return Snapshot();
	}
	private void Fail(Worker worker, Exception error, Entry? entry = null, bool dispatched = false)
	{
		var failure = failures.Classify(error);
		var lockLost = failure.Kind is MessageFailureKind.MessageLockLost or MessageFailureKind.SessionLockLost;
		var rejected = lockLost || error is OperationException or UnauthorizedAccessException or ArgumentException ||
			failure.IsRequestRejected ||
			failure.Kind is MessageFailureKind.EntityNotFound or MessageFailureKind.EntityDisabled;
		var ambiguous = dispatched && !rejected;
		lock (sync)
		{
			failed++;
			if (ambiguous)
				uncertain++;
			if (outcome != "unknown")
				outcome = ambiguous ? "unknown" : "failed";
			if (ambiguous || outcomeSummary is null)
				outcomeSummary = ambiguous
				? "One or more settlements may have succeeded. No settlement was retried; review uncertain sessions before restarting."
				: lockLost ? "A session lock was lost. All workers stopped without retrying settlement."
				: error is OperationException known ? known.Message : "A session receiver or permission error stopped all workers. No settlement was retried.";
			status = "stopping";
			summary = outcomeSummary;
			if (entry is not null)
				entry.Info = entry.Info with
				{
					State = ambiguous ? "unknown" : lockLost ? "lock-lost" : "released"
				};
			if (worker.Session is { } session)
			{
				session.Failed++;
				if (ambiguous)
					session.Uncertain++;
				session.Status = session.Uncertain > 0 ? "unknown" : "failed";
				session.Summary = ambiguous ? "Settlement outcome unknown; no retry." : lockLost ? "Session lock lost." : "Session failed; no retry.";
			}
		}
		stop.Cancel();
	}
	private async Task Run()
	{
		try
		{
			await Task.WhenAll(workers.Select(w => Task.Run(() => RunWorker(w))));
		}
		finally
		{
			lock (sync)
			{
				status = outcome ?? (deadline.IsCancellationRequested || received >= maxMessages ? "limited" : "stopped");
				summary = outcomeSummary ?? (deadline.IsCancellationRequested ? "Time limit reached." : received >= maxMessages ? "Shared message limit reached." : "All session workers stopped.");
				summary += " Confirmed settlements are permanent. Unsettled messages were not completed; failed cleanup may leave session locks until expiry.";
				endedMs = clock.ElapsedMilliseconds;
			}
			lifetime.Dispose();
			deadline.Dispose();
		}
	}
	private async Task RunWorker(Worker worker)
	{
		try
		{
			while (!token.IsCancellationRequested)
			{
				int pause;
				await worker.Io.WaitAsync(token);
				try
				{
					pause = await Step(worker);
				}
				finally { worker.Io.Release(); }
				if (pause < 0)
					break;
				if (pause > 0)
					await Task.Delay(pause, token);
				else
					await Task.Yield();
			}
		}
		catch (OperationCanceledException) when (token.IsCancellationRequested) { }
		catch (Exception error) { Fail(worker, error, worker.Pending); }
		finally
		{
			await worker.Io.WaitAsync();
			try
			{
				await Release(worker, "released", "Session released when the worker stopped.");
			}
			finally { worker.Io.Release(); }
		}
	}
	private async Task<int> Step(Worker worker)
	{
		token.ThrowIfCancellationRequested();
		if (worker.Receiver is not null)
			await Renew(worker);
		token.ThrowIfCancellationRequested();
		if (worker.Pending is not null)
			return 100;
		lock (sync)
			if (received >= maxMessages)
				return -1;
		if (worker.Receiver is null)
		{
			lock (sync)
			{
				if (received + reserved >= maxMessages)
					return 100;
				worker.Accepting = true;
			}
			IMessageReceiver receiver;
			using var acceptance = CancellationTokenSource.CreateLinkedTokenSource(token, acceptStop.Token);
			try
			{
				receiver = await gateway.OpenNextSessionAsync(target, acceptance.Token);
			}
			catch (OperationCanceledException) when (acceptStop.IsCancellationRequested && !token.IsCancellationRequested) { return -1; }
			catch (Exception error) when (failures.Classify(error).Kind is MessageFailureKind.Timeout or MessageFailureKind.SessionUnavailable)
			{
				token.ThrowIfCancellationRequested();
				return 250;
			}
			finally { lock (sync) worker.Accepting = false; }
			// Own even a late-acquired receiver before observing cancellation, so cleanup always disposes it.
			lock (sync)
				worker.Receiver = receiver;
			token.ThrowIfCancellationRequested();
			if (string.IsNullOrEmpty(receiver.SessionId) || receiver.SessionId.Length > 128)
				throw new OperationException(OperationFailure.ReceiverContractViolation, "The session receiver returned an invalid session ID. Nothing was completed.");
			lock (sync)
			{
				if (workers.Any(w => w != worker && w.Session?.SessionId == receiver.SessionId && w.Receiver is not null))
					throw new OperationException(OperationFailure.ReceiverContractViolation, "The broker returned an already owned session. All workers stopped.");
				var session = sessions.FirstOrDefault(s => s.SessionId == receiver.SessionId);
				if (session is null)
				{
					if (sessions.Count == 100)
					{
						var oldest = sessions.First(s => !workers.Any(w => w.Session == s && w.Receiver is not null));
						sessions.Remove(oldest);
						sessionsEvicted++;
					}
					session = new(receiver.SessionId);
					sessions.Add(session);
				}
				session.Status = "receiving";
				session.Summary = "Session acquired.";
				session.LockedUntil = receiver.SessionLockedUntil is { } until ? Timestamp(until) : null;
				worker.Session = session;
				worker.LastReceivedMs = clock.ElapsedMilliseconds;
				acquisitions++;
			}
			await Renew(worker);
		}
		token.ThrowIfCancellationRequested();
		lock (sync)
		{
			if (received >= maxMessages)
				return -1;
			if (received + reserved >= maxMessages)
				return 100;
			reserved++;
		}
		IReadOnlyList<ReceivedMessage> batch;
		var accounted = false;
		try
		{
			batch = await worker.Receiver.ReceiveAsync(1, TimeSpan.FromSeconds(1), token);
			lock (sync)
			{
				reserved--;
				accounted = true;
				received += batch.Count;
				worker.Session!.Received += batch.Count;
			}
		}
		finally { if (!accounted) lock (sync) reserved--; }
		if (received >= maxMessages)
			acceptStop.Cancel();
		if (batch.Count > 1)
			throw new OperationException(OperationFailure.ReceiverContractViolation, "Unexpected session batch. No messages in it were completed.");
		if (batch.Count == 0)
		{
			if (clock.ElapsedMilliseconds - worker.LastReceivedMs >= idleSeconds * 1000L)
				await Release(worker, "idle", "Idle session released; worker can accept another session.");
			return 100;
		}
		// Retain a returned PeekLock delivery even if stop raced its return. Never complete after stop.
		var message = batch[0];
		var body = message.Body.ToMemory();
		if (body.Length > Budget)
			throw new OperationException(OperationFailure.InspectionLimit, "Message exceeds the 16 MiB shared history budget. It was not completed.");
		var deliveryId = Guid.NewGuid().ToString();
		static string? Clip(string? value, int length) => value?.Length > length ? value[..length] : value;
		var projection = Summary(message, deliveryId, body.Length) with
		{
			Subject = Clip(message.Subject, 512),
			ContentType = Clip(message.ContentType, 128),
			MessageId = Clip(message.MessageId, 128),
			SessionId = Clip(message.SessionId, 128)
		};
		var metadata = JsonSerializer.SerializeToUtf8Bytes(Details(message, projection)).Length;
		if (metadata > 131072 || body.Length + metadata > Budget)
			throw new OperationException(OperationFailure.InspectionLimit, "Message properties exceed the shared history budget. It was not completed.");
		var entry = new Entry(worker, message, new(deliveryId, projection, "active", Timestamp(worker.Receiver.LockedUntil(message)), Timestamp(DateTimeOffset.UtcNow)), body.Length + metadata, clock.ElapsedMilliseconds);
		lock (sync)
		{
			while (history.Count >= 100 || retainedBytes + entry.Size > Budget)
			{
				var removable = history.FirstOrDefault(e => e.Info.State is not ("active" or "settling"));
				if (removable is null)
					throw new OperationException(OperationFailure.InspectionLimit, "Pending messages filled the 16 MiB shared history budget. No further messages were completed.");
				history.Remove(removable);
				retainedBytes -= removable.Size;
				evicted++;
			}
			history.Add(entry);
			retainedBytes += entry.Size;
			worker.Pending = entry;
			worker.LastReceivedMs = clock.ElapsedMilliseconds;
			worker.Session!.Pending = 1;
			worker.Session.Status = mode == "manual" ? "waiting" : "receiving";
			worker.Session.Summary = mode == "manual" ? "Waiting for manual settlement; session lock renews during review." : "Completing received message.";
			if (status == "running")
				summary = "Processing available sessions. One outstanding delivery per session.";
		}
		token.ThrowIfCancellationRequested();
		if (mode == "auto-complete")
			await SettleEntry(worker, entry, "complete", "", "", token);
		return mode == "manual" ? 100 : 0;
	}
	private async Task Renew(Worker worker)
	{
		if (worker.Pending is { } pending && clock.ElapsedMilliseconds - pending.ReceivedMs >= maxLockSeconds * 1000L)
		{
			lock (sync)
			{
				outcome ??= "limited";
				outcomeSummary ??= "Manual review time limit reached. All session workers stopped without completing pending messages.";
				status = "stopping";
				summary = outcomeSummary;
			}
			stop.Cancel();
			return;
		}
		var until = worker.Receiver!.SessionLockedUntil;
		if (until is null || until <= DateTimeOffset.UtcNow)
			throw new MessageFailureException(MessageFailureKind.SessionLockLost, "Session lock unavailable");
		if (until > DateTimeOffset.UtcNow.AddSeconds(15))
			return;
		await worker.Receiver.RenewSessionLockAsync(token);
		lock (sync)
		{
			renewed++;
			worker.Session!.Renewed++;
			worker.Session.LockedUntil = Timestamp(worker.Receiver.SessionLockedUntil!.Value);
			if (worker.Pending is { } entry)
				entry.Info = entry.Info with
				{
					LockedUntil = Timestamp(worker.Receiver.LockedUntil(entry.Message))
				};
		}
	}
	private async Task Release(Worker worker, string state, string message)
	{
		var receiver = worker.Receiver;
		if (receiver is null)
			return;
		try
		{
			await receiver.DisposeAsync();
		}
		catch { Fail(worker, new OperationException(OperationFailure.OperationBlocked, "Session receiver cleanup could not be confirmed. Review the source before restarting.")); }
		finally
		{
			lock (sync)
			{
				if (worker.Pending is { } entry && entry.Info.State is "active" or "settling")
					entry.Info = entry.Info with
					{
						State = "released"
					};
				if (worker.Session is { } session)
				{
					session.Pending = 0;
					session.LockedUntil = null;
					if (session.Status is not ("failed" or "unknown"))
					{
						session.Status = state;
						session.Summary = message;
					}
				}
				worker.Pending = null;
				worker.Receiver = null;
				worker.Session = null;
			}
		}
	}
	private async Task SettleEntry(Worker worker, Entry entry, string action, string reason, string description, CancellationToken cancellation)
	{
		cancellation.ThrowIfCancellationRequested();
		lock (sync)
			entry.Info = entry.Info with
			{
				State = "settling"
			};
		try
		{
			await worker.Receiver!.SettleAsync(entry.Message, action, reason, description, cancellation);
			var referenceWarning = action == "defer" ? recordDeferred?.Invoke(entry.Message.SequenceNumber, worker.Receiver.SessionId) : null;
			lock (sync)
			{
				entry.Info = entry.Info with
				{
					State = action switch
					{
						"complete" => "completed",
						"abandon" => "abandoned",
						"dead-letter" => "dead-lettered",
						_ => "deferred"
					}
				};
				worker.Pending = null;
				worker.LastReceivedMs = clock.ElapsedMilliseconds;
				var session = worker.Session!;
				session.Pending = 0;
				session.Status = "receiving";
				session.Summary = "Settlement confirmed.";
				deferredReferenceWarning ??= referenceWarning;
				if (referenceWarning is not null)
					session.Summary = referenceWarning;
				switch (action)
				{
					case "complete":
						completed++;
						session.Completed++;
						break;
					case "abandon":
						abandoned++;
						session.Abandoned++;
						break;
					case "dead-letter":
						deadLettered++;
						session.DeadLettered++;
						break;
					case "defer":
						deferred++;
						session.Deferred++;
						break;
				}
			}
		}
		catch (Exception error) { Fail(worker, error, entry, dispatched: true); }
	}
	public async Task<ListenerState> Settle(ListenerSettlement request, string fingerprint, CancellationToken cancellation)
	{
		var id = request.Id;
		var deliveryId = request.DeliveryId;
		var action = request.Action;
		var reason = request.Reason;
		var description = request.Description;
		if (!Guid.TryParse(id, out _) || !Guid.TryParse(deliveryId, out _) || action is not ("complete" or "abandon" or "dead-letter" or "defer") || reason.Length > 128 || description.Length > 4096)
			throw new OperationException(OperationFailure.InvalidInput, "Invalid listener settlement request.");
		Settlement receipt;
		Entry? entry = null;
		lock (sync)
		{
			if (settlements.TryGetValue(id, out var prior))
			{
				if (prior.Fingerprint != fingerprint)
					throw new OperationException(OperationFailure.InvalidInput, "Settlement ID was reused with different input.");
				receipt = prior;
			}
			else
			{
				if (settlements.Count >= 1000)
					throw new OperationException(OperationFailure.OperationBlocked, "Listener settlement receipt limit reached. Stop and review the listener.");
				entry = history.FirstOrDefault(e => e.Info.DeliveryId == deliveryId);
				if (status != "running" || mode != "manual" || entry is null || entry.Worker.Pending != entry || entry.Info.State != "active")
					throw new OperationException(OperationFailure.OperationBlocked, "This listener delivery is no longer available for manual settlement. Refresh the listener.");
				receipt = new(fingerprint, new(TaskCreationOptions.RunContinuationsAsynchronously));
				settlements.Add(id, receipt);
			}
		}
		if (entry is null)
		{
			await receipt.Done.Task.WaitAsync(cancellation);
			return Snapshot();
		}
		try
		{
			using var requestLifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation, token);
			var requestToken = requestLifetime.Token;
			await entry.Worker.Io.WaitAsync(requestToken);
			try
			{
				lock (sync)
					if (status != "running" || entry.Worker.Pending != entry || entry.Info.State != "active")
						throw new OperationException(OperationFailure.OperationBlocked, "This listener delivery is no longer available for manual settlement. Refresh the listener.");
				await SettleEntry(entry.Worker, entry, action, reason, description, requestToken);
			}
			finally { entry.Worker.Io.Release(); }
		}
		finally { receipt.Done.TrySetResult(); }
		return Snapshot();
	}
}
