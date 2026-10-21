using System.Diagnostics;
using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.EventHubs.Connections;
using MsgCommander.Application.EventHubs.Gateways;
using MsgCommander.Contracts.EventHubs.Browsing;
using MsgCommander.Contracts.EventHubs.Messaging;
using static MsgCommander.Application.Common.DisplayValues;
using static MsgCommander.Application.EventHubs.Messaging.EventProjection;

namespace MsgCommander.Application.EventHubs.Messaging;

// One run owns cancellation, receiver workers and all atomic retention/checkpoint transitions.
internal sealed class EventListenerRun : IDisposable
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	private readonly IEventHubsGateway gateway;
	private readonly EventHubsConnection connection;
	private readonly EventSnapshotStore store;
	private readonly EventHubResourceCleanup cleanup;
	private readonly EventListenRequest request;
	private readonly Func<EventListenProgress, Task> emit;
	private readonly CancellationToken cancellation;
	private readonly CancellationTokenSource deadline, stop = new(), lifetime;
	private readonly SemaphoreSlim permits;
	private readonly Stopwatch clock = Stopwatch.StartNew();
	private readonly EventStatisticsCounter statistics = new();
	private readonly EventListenerPlan plan = new();
	private readonly object sync = new();
	private readonly List<EventListenerItem> items = [];
	private long bytes, lastProgress = -1000;
	private int summaryBytes, received, active;
	private string? reason, detail, cleanupWarning;
	private CancellationToken Token => lifetime.Token;

	public EventListenerRun(IEventHubsGateway gateway, EventHubsConnection connection, EventSnapshotStore store,
		EventHubResourceCleanup cleanup, EventListenRequest request, Func<EventListenProgress, Task> emit,
		CancellationToken cancellation)
	{
		this.gateway = gateway;
		this.connection = connection;
		this.store = store;
		this.cleanup = cleanup;
		this.request = request;
		this.emit = emit;
		this.cancellation = cancellation;
		deadline = new(TimeSpan.FromSeconds(request.MaxSeconds));
		lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation, deadline.Token, stop.Token);
		permits = new(request.MaxEvents);
	}

	public async Task<EventListenResult> ExecuteAsync(EventCheckpoint? checkpoint)
	{
		try
		{
			await ProgressAsync("validating", true);
			await plan.PrepareAsync(gateway, request, checkpoint, Token);
			store.Clear();
			var workers = Math.Min(request.Concurrency, plan.Partitions.Count);
			await Task.WhenAll(Enumerable.Range(0, workers).Select(worker => WorkerAsync(worker, workers)));
		}
		catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
		catch (Exception error) { Stop("error", Failure(error, true)); }
		await ProgressAsync("closing", true);
		return Complete();
	}

	public async Task ProgressAsync(string phase, bool force = false)
	{
		EventListenProgress value;
		lock (sync)
		{
			if (!force && clock.ElapsedMilliseconds - lastProgress < 250)
				return;
			lastProgress = clock.ElapsedMilliseconds;
			value = new(request.Id, received, request.MaxEvents, clock.ElapsedMilliseconds, active, phase,
				plan.Partitions.Select(p => p.Progress()).ToArray(), statistics.Snapshot());
		}
		try
		{
			await emit(value);
		}
		catch
		{
			// Progress failure cannot discard retained events.
		}
	}

	private void Stop(string why, string? message = null)
	{
		lock (sync)
		{
			if (reason is null || why == "error" || why == "buffer-limit" && reason == "count")
			{
				reason = why;
				detail = message;
			}
		}
		stop.Cancel();
	}

	private async Task WorkerAsync(int worker, int workerCount)
	{
		await Task.Yield();
		var assigned = plan.Partitions.Where((_, index) => index % workerCount == worker).ToArray();
		var next = 0;
		while (!Token.IsCancellationRequested)
			await ReadPartitionAsync(assigned[next++ % assigned.Length], assigned.Length == 1);
	}

	private async Task ReadPartitionAsync(EventListenerPartition partition, bool onlyPartition)
	{
		IEventHubReader? reader = null;
		try
		{
			Token.ThrowIfCancellationRequested();
			reader = gateway.OpenReader(request.HubName, request.ConsumerGroup, partition.Id,
				EventHubsValidation.Position(partition.Position));
			lock (sync)
			{
				active++;
				partition.Status = "reading";
			}
			await ProgressAsync("listening", true);
			var quantum = Stopwatch.StartNew();
			var turns = 0;
			do
			{
				await ReadOneAsync(reader, partition);
				await ProgressAsync("listening");
				turns++;
			} while (!Token.IsCancellationRequested && (onlyPartition || turns < 25 && quantum.ElapsedMilliseconds < 1000));
		}
		catch (OperationCanceledException) when (Token.IsCancellationRequested) { }
		catch (Exception error)
		{
			lock (sync)
			{
				partition.Status = "failed";
				partition.Error = Failure(error, false);
			}
			Stop("error", partition.Error);
		}
		finally
		{
			if (reader is not null)
			{
				if (!await cleanup.CloseAsync(reader))
				{
					lock (sync)
						cleanupWarning = "Receiver cleanup could not be confirmed. Disconnect before another read; a backend restart may be required.";
					Stop("error", cleanupWarning);
				}
				lock (sync)
					active--;
			}
			lock (sync)
				if (partition.Status != "failed")
					partition.Status = Token.IsCancellationRequested ? "stopped" : "queued";
			await ProgressAsync("listening");
		}
	}

	private async Task ReadOneAsync(IEventHubReader reader, EventListenerPartition partition)
	{
		await permits.WaitAsync(Token);
		var retained = false;
		try
		{
			var batch = await statistics.Measure(() => reader.ReadAsync(TimeSpan.FromMilliseconds(250), Token), b => b.Count == 0);
			if (batch.Count > 1)
				throw new OperationException(OperationFailure.ReceiverContractViolation, "Reader exceeded the requested batch size.");
			if (batch.Count == 0)
			{
				lock (sync)
					partition.Status = "waiting";
				await Task.Delay(25, Token);
			}
			else
				retained = TryRetain(partition, batch[0]);
		}
		finally { if (!retained) permits.Release(); }
		bool limitReached;
		lock (sync)
			limitReached = reason is "count" or "buffer-limit";
		if (limitReached)
			stop.Cancel();
	}

	private bool TryRetain(EventListenerPartition partition, ReceivedEvent value)
	{
		var body = value.EventBody.ToMemory();
		var id = Guid.NewGuid().ToString();
		var summary = new EventSummary(id, Number(value.SequenceNumber), value.OffsetString,
			Timestamp(value.EnqueuedTime), Clip(value.PartitionKey), body.Length, null);
		var row = new EventListenerItem(partition.Id, id, summary.SequenceNumber, summary.Offset,
			summary.EnqueuedTime, summary.PartitionKey, body.Length, null);
		var size = JsonSerializer.SerializeToUtf8Bytes(row, Json).Length;
		var app = Properties(value.Properties, out var appWarning);
		var system = Properties(value.SystemProperties, out var systemWarning);
		var warning = appWarning || systemWarning || value.MessageId?.Length > 256 ||
			value.ContentType?.Length > 256 || value.CorrelationId?.Length > 256
			? "Some properties were truncated or omitted to fit the inspection limit." : null;
		var details = new EventDetails(summary, app, system, warning,
			Clip(value.MessageId), Clip(value.ContentType), Clip(value.CorrelationId));
		lock (sync)
		{
			if (bytes + body.Length > EventSnapshotStore.Budget || summaryBytes + size > 262144)
			{
				reason = "buffer-limit";
				return false;
			}
			// The snapshot must be retained before its sequence can enter a checkpoint.
			store.Snapshots.Add(id, (summary, body, details));
			store.Origins.Add(id, (connection.Namespace, request.HubName, request.ConsumerGroup, partition.Id));
			items.Add(row);
			received++;
			partition.Received++;
			partition.Bytes += body.Length;
			statistics.Body(body.Length);
			partition.LastSequence = summary.SequenceNumber;
			partition.Position = EventListenerPlan.SequencePosition(summary.SequenceNumber, false);
			partition.Status = "reading";
			bytes += body.Length;
			summaryBytes += size;
			if (received == request.MaxEvents && reason is null)
				reason = "count";
			return true;
		}
	}

	private string Failure(Exception error, bool preflight)
	{
		if (error is OperationException operation)
			return operation.Message;
		if (preflight)
			return connection.Service == "iot-hub"
			? "IoT Hub listener preflight failed. Check the current compatible endpoint, ServiceConnect permission, consumer group and connectivity. No events were retried."
			: "Listener preflight failed. Check the hub, consumer group, data receiver access and connection. No events were retried.";
		return connection.Service == "iot-hub"
			? "IoT Hub partition read failed. Check ServiceConnect permission, the consumer group, compatible endpoint and connectivity. No receiver was retried."
			: "Partition read failed. Check Listen/Data Receiver rights, the consumer group and connectivity. No receiver was retried.";
	}

	private EventListenResult Complete()
	{
		lock (sync)
		{
			reason ??= cancellation.IsCancellationRequested ? "cancelled" : "time";
			foreach (var partition in plan.Partitions)
				if (partition.Status != "failed")
					partition.Status = "stopped";
			var status = reason == "error" ? "failed" : reason == "cancelled" ? "cancelled" : reason == "count" ? "completed" : "limited";
			var checkpoint = plan.Ready ? new EventCheckpoint("msg-commander/event-checkpoints", 1,
				connection.Namespace, request.HubName, request.ConsumerGroup, plan.Hub!.CreatedAt,
				Timestamp(DateTimeOffset.UtcNow), plan.Partitions.Select(p => new EventCheckpointPartition(p.Id, p.Position, p.Floor)).ToArray()) : null;
			var text = reason switch
			{
				"count" => "Event limit reached.",
				"time" => "Time limit reached; idle partitions may receive events later.",
				"cancelled" => "Cancelled.",
				"buffer-limit" => "Inspection buffer limit reached; the unread position remains in the checkpoint.",
				_ => detail
			};
			return new(request.Id, request.HubName, request.ConsumerGroup, request.Concurrency, request.MaxEvents,
				request.MaxSeconds, status, reason, received, clock.ElapsedMilliseconds,
				plan.Partitions.Select(p => p.Progress()).ToArray(), items.ToArray(), checkpoint,
				$"{received} events retained across {plan.Partitions.Count} partitions. {text} No events were deleted. Save a local checkpoint explicitly to resume later.",
				cleanupWarning, statistics.Snapshot());
		}
	}

	public void Dispose()
	{
		permits.Dispose();
		lifetime.Dispose();
		stop.Dispose();
		deadline.Dispose();
	}
}
