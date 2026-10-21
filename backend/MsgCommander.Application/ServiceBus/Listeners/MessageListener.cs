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

public interface IMessageListener
{
	string Id
	{
		get;
	}
	string ConnectionId
	{
		get;
	}
	string Fingerprint
	{
		get;
	}
	bool Active
	{
		get;
	}
	void Start();
	ListenerState Snapshot();
	Task<ListenerState> Stop();
	Task<ListenerState> Settle(ListenerSettlement request, string fingerprint, CancellationToken cancellation);
	(ReceivedMessage Message, ReadOnlyMemory<byte> Body, MessageSummary Summary)? Inspect(string snapshotId);
}

// The listener owns its receiver and serializes receive/renew/settle separately from namespace browsing.
// UI polling reads a bounded snapshot: no unbounded event queue or body payloads in progress/history.
public sealed class MessageListener(string id, string connectionId, EntityTarget target, string mode, int maxMessages, int maxSeconds, int maxLockSeconds, IMessageReceiver receiver, IMessageFailureClassifier failures, Func<long, string?, string?>? recordDeferred = null) : IMessageListener
{
	private const int Budget = 16 * 1024 * 1024;
	private sealed class Entry(ReceivedMessage message, ListenerItem info, int size)
	{
		public ReceivedMessage Message = message;
		public ListenerItem Info = info;
		public int Size = size;
		public long ReceivedMs;
	}
	private readonly object sync = new();
	private readonly SemaphoreSlim io = new(1);
	private readonly CancellationTokenSource stop = new();
	private readonly CancellationTokenSource deadline = new(TimeSpan.FromSeconds(maxSeconds));
	private readonly Stopwatch clock = Stopwatch.StartNew();
	private readonly List<Entry> history = [];
	private readonly Dictionary<string, string> settlements = [];
	private Task work = Task.CompletedTask;
	private Entry? pending;
	private string status = "running", summary = "Listening for messages.";
	private string? deferredReferenceWarning;
	private int received, completed, abandoned, deadLettered, deferred, failed, uncertain, renewed, retainedBytes, evicted;
	private long? endedMs;
	public string Id => id;
	public string ConnectionId => connectionId;
	public string Fingerprint { get; init; } = "";
	public bool Active
	{
		get
		{
			lock (sync)
				return status is "running" or "stopping";
		}
	}
	public void Start() => work = Task.Run(Run);
	public ListenerState Snapshot()
	{
		lock (sync)
			return new(id, connectionId, target, receiver.SessionId, mode, status, received, completed, abandoned, deadLettered, deferred,
			failed, uncertain, renewed, endedMs ?? clock.ElapsedMilliseconds, maxMessages, maxSeconds, maxLockSeconds, retainedBytes, evicted, deferredReferenceWarning is null ? summary : summary + " " + deferredReferenceWarning,
			history.Select(e => e.Info).Reverse().ToArray(), "single", 1, 5, receiver.SessionId is not null && endedMs is null ? 1 : 0, 0, receiver.SessionId is null ? 0 : 1, 0, []);
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
				summary = "Stopping; awaiting any in-flight broker result.";
			}
		await stop.CancelAsync();
		await work;
		return Snapshot();
	}
	private void Fail(Exception error, Entry? entry = null, bool dispatched = false)
	{
		var failure = failures.Classify(error);
		var lockLost = failure.Kind is MessageFailureKind.MessageLockLost or MessageFailureKind.SessionLockLost;
		var rejected = lockLost || error is OperationException or UnauthorizedAccessException or ArgumentException || failure.IsRequestRejected;
		lock (sync)
		{
			failed++;
			uncertain = dispatched && !rejected ? 1 : 0;
			status = uncertain > 0 ? "unknown" : "failed";
			summary = uncertain > 0 ? "The last settlement may have succeeded. It was not retried. Inspect the source before starting another listener."
				: lockLost ? "The receiver lock was lost. The listener stopped without retrying settlement."
				: error is OperationException known ? known.Message : "Listener stopped after a receiver or permission error. No settlement was retried.";
			if (entry is not null)
				entry.Info = entry.Info with
				{
					State = uncertain > 0 ? "unknown" : lockLost ? "lock-lost" : "released"
				};
		}
		stop.Cancel();
	}
	private async Task Renew(CancellationToken token)
	{
		Entry? entry;
		lock (sync)
			entry = pending;
		if (entry is not null && clock.ElapsedMilliseconds - entry.ReceivedMs >= maxLockSeconds * 1000L)
		{
			lock (sync)
			{
				status = "limited";
				summary = "Manual review time limit reached. The unsettled message was not completed.";
			}
			stop.Cancel();
			return;
		}
		var until = receiver.SessionLockedUntil ?? (entry is null ? (DateTimeOffset?)null : receiver.LockedUntil(entry.Message));
		if (until is null)
			return;
		if (until <= DateTimeOffset.UtcNow)
			throw new MessageFailureException(receiver.SessionId is null ? MessageFailureKind.MessageLockLost : MessageFailureKind.SessionLockLost, "Lock expired");
		if (until - DateTimeOffset.UtcNow > TimeSpan.FromSeconds(15))
			return;
		if (receiver.SessionId is not null)
			await receiver.RenewSessionLockAsync(token);
		else if (entry is not null)
			await receiver.SettleAsync(entry.Message, "renew", "", "", token);
		lock (sync)
		{
			renewed++;
			if (entry is not null)
				entry.Info = entry.Info with
				{
					LockedUntil = Timestamp(receiver.LockedUntil(entry.Message))
				};
		}
	}
	private async Task Run()
	{
		using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(stop.Token, deadline.Token);
		var token = lifetime.Token;
		try
		{
			while (!token.IsCancellationRequested)
			{
				var pause = true;
				await io.WaitAsync(token);
				try
				{
					await Renew(token);
					token.ThrowIfCancellationRequested();
					bool waiting;
					lock (sync)
						waiting = pending is not null;
					if (!waiting)
					{
						if (received >= maxMessages)
						{
							lock (sync)
							{
								status = "limited";
								summary = "Message limit reached.";
							}
							break;
						}
						var batch = await receiver.ReceiveAsync(1, TimeSpan.FromSeconds(1), token);
						if (batch.Count > 1)
							throw new OperationException(OperationFailure.ReceiverContractViolation, "Unexpected listener batch. No messages in it were completed.");
						if (batch.Count == 1)
						{
							// Even if cancellation arrived during receive, track the delivery before cleanup.
							var message = batch[0];
							lock (sync)
								received++;
							ReadOnlyMemory<byte> body;
							try
							{
								body = message.Body.ToMemory();
							}
							catch (NotSupportedException) { throw new OperationException(OperationFailure.InspectionLimit, "Unsupported body format. Listener stopped without completing this message."); }
							if (body.Length > Budget)
								throw new OperationException(OperationFailure.InspectionLimit, "Message exceeds the 16 MiB listener history budget. It was not completed.");
							var deliveryId = Guid.NewGuid().ToString();
							var projection = Summary(message, deliveryId, body.Length);
							projection = projection with
							{
								Subject = Clip(projection.Subject, 512),
								ContentType = Clip(projection.ContentType, 128),
								MessageId = Clip(projection.MessageId, 128),
								SessionId = Clip(projection.SessionId, 128)
							};
							var metadata = JsonSerializer.SerializeToUtf8Bytes(Details(message, projection)).Length;
							if (metadata > 131072 || body.Length + metadata > Budget)
								throw new OperationException(OperationFailure.InspectionLimit, "Message properties exceed the listener retention budget. It was not completed.");
							var entry = new Entry(message, new(deliveryId, projection, "active", Timestamp(receiver.LockedUntil(message)), Timestamp(DateTimeOffset.UtcNow)), body.Length + metadata) { ReceivedMs = clock.ElapsedMilliseconds };
							lock (sync)
							{
								while (history.Count >= 100 || retainedBytes + entry.Size > Budget)
								{
									retainedBytes -= history[0].Size;
									history.RemoveAt(0);
									evicted++;
								}
								history.Add(entry);
								retainedBytes += entry.Size;
								pending = entry;
								summary = mode == "manual" ? "Waiting for manual settlement; the message lock is renewed during review." : "Receiving and completing messages automatically.";
							}
							token.ThrowIfCancellationRequested();
							if (mode == "auto-complete")
							{
								await SettleEntry(entry, "complete", "", "", token);
								pause = false;
							}
						}
					}
				}
				finally { io.Release(); }
				// Empty fixture reads and fast brokers cannot spin or build an unbounded UI event queue.
				if (pause)
					await Task.Delay(100, token);
				else
					await Task.Yield();
			}
		}
		catch (OperationCanceledException) when (token.IsCancellationRequested) { }
		catch (Exception error) { Fail(error, pending); }
		finally
		{
			// A concurrent manual settlement must finish before disposing its receiver.
			await io.WaitAsync();
			try
			{
				try
				{
					await receiver.DisposeAsync();
				}
				catch { lock (sync) { failed++; summary += " Receiver cleanup could not be confirmed."; if (status is "running" or "stopping") status = "failed"; } }
				lock (sync)
				{
					if (pending is not null && pending.Info.State is "active" or "settling")
						pending.Info = pending.Info with
						{
							State = "released"
						};
					pending = null;
					if (status is "running" or "stopping")
					{
						status = deadline.IsCancellationRequested ? "limited" : "stopped";
						summary = deadline.IsCancellationRequested ? "Time limit reached." : "Listener stopped.";
					}
					summary += " Unsettled deliveries may remain locked until expiry. Confirmed settlements are permanent.";
					endedMs = clock.ElapsedMilliseconds;
				}
			}
			finally { io.Release(); deadline.Dispose(); }
		}
	}
	private static string? Clip(string? value, int max) => value?.Length > max ? value[..max] : value;
	private async Task SettleEntry(Entry entry, string action, string reason, string description, CancellationToken token)
	{
		token.ThrowIfCancellationRequested();
		lock (sync)
			entry.Info = entry.Info with
			{
				State = "settling"
			};
		try
		{
			await receiver.SettleAsync(entry.Message, action, reason, description, token);
			var referenceWarning = action == "defer" ? recordDeferred?.Invoke(entry.Message.SequenceNumber, receiver.SessionId) : null;
			// An acknowledgement wins a concurrent stop. Never report it as unconfirmed.
			lock (sync)
			{
				var state = action switch
				{
					"complete" => "completed",
					"abandon" => "abandoned",
					"dead-letter" => "dead-lettered",
					_ => "deferred"
				};
				entry.Info = entry.Info with
				{
					State = state
				};
				pending = null;
				switch (action)
				{
					case "complete":
						completed++;
						break;
					case "abandon":
						abandoned++;
						break;
					case "dead-letter":
						deadLettered++;
						break;
					case "defer":
						deferred++;
						break;
				}
				deferredReferenceWarning ??= referenceWarning;
				summary = "Settlement confirmed. Listening for the next message.";
			}
		}
		catch (Exception error) { Fail(error, entry, dispatched: true); }
	}
	public async Task<ListenerState> Settle(ListenerSettlement request, string fingerprint, CancellationToken cancellation)
	{
		var requestId = request.Id;
		var deliveryId = request.DeliveryId;
		var action = request.Action;
		var reason = request.Reason;
		var description = request.Description;
		if (!Guid.TryParse(requestId, out _) || !Guid.TryParse(deliveryId, out _) || action is not ("complete" or "abandon" or "dead-letter" or "defer") || reason.Length > 128 || description.Length > 4096)
			throw new OperationException(OperationFailure.InvalidInput, "Invalid listener settlement request.");
		await io.WaitAsync(cancellation);
		try
		{
			if (settlements.TryGetValue(requestId, out var prior))
			{
				if (prior != fingerprint)
					throw new OperationException(OperationFailure.InvalidInput, "Settlement ID was reused with different input.");
				return Snapshot();
			}
			if (settlements.Count >= 1000)
				throw new OperationException(OperationFailure.OperationBlocked, "Listener settlement receipt limit reached. Stop and review before starting another listener.");
			Entry entry;
			lock (sync)
			{
				if (status != "running" || mode != "manual" || pending is null || pending.Info.DeliveryId != deliveryId || pending.Info.State != "active")
					throw new OperationException(OperationFailure.OperationBlocked, "This listener delivery is no longer available for manual settlement. Refresh the listener.");
				entry = pending;
			}
			using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation, stop.Token, deadline.Token);
			lifetime.Token.ThrowIfCancellationRequested();
			settlements.Add(requestId, fingerprint);
			await SettleEntry(entry, action, reason, description, lifetime.Token);
			return Snapshot();
		}
		finally { io.Release(); }
	}
}
