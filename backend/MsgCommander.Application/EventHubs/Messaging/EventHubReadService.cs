using System.Diagnostics;
using MsgCommander.Application.Common;
using MsgCommander.Application.EventHubs.Gateways;
using MsgCommander.Application.EventHubs.Connections;
using MsgCommander.Contracts.EventHubs.Messaging;
using MsgCommander.Contracts.EventHubs.Browsing;
using static MsgCommander.Application.Common.DisplayValues;
using static MsgCommander.Application.EventHubs.Messaging.EventProjection;

namespace MsgCommander.Application.EventHubs.Messaging;

public sealed class EventHubReadService(IEventHubsGateway gateway, EventHubsConnection connection, EventSnapshotStore store, EventHubResourceCleanup cleanup)
{
	private const int Budget = EventSnapshotStore.Budget;
	private readonly Dictionary<string, (string Fingerprint, EventHubReadResult Result)> reads = [];
	public EventHubReadResult? GetResult(string id) => reads.TryGetValue(id, out var prior) ? prior.Result : null;
	public EventHubReadResult? CheckRequest(string id, string stamp)
	{
		if (!Guid.TryParse(id, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid read operation ID.");
		if (reads.TryGetValue(id, out var prior))
		{
			if (prior.Fingerprint != stamp)
				throw new OperationException(OperationFailure.InvalidInput, "Read ID was used for another request.");
			return prior.Result;
		}
		if (reads.Count >= 100)
			throw new OperationException(OperationFailure.OperationBlocked, "Read receipt limit reached. Reconnect after reviewing results.");
		if (cleanup.HasFailures)
			throw new OperationException(OperationFailure.OperationBlocked, "Disconnect before another read because client cleanup could not be confirmed.");
		return null;
	}
	public void Clear() => reads.Clear();
	public async Task<EventHubReadResult> ExecuteAsync(EventHubReadRequest request, string stamp, Func<EventHubReadProgress, Task> emit, CancellationToken cancellation)
	{
		var id = request.Id;
		if (CheckRequest(id, stamp) is { } previous)
			return previous;
		var hub = EventHubsValidation.Name(request.HubName);
		var group = EventHubsValidation.Name(request.ConsumerGroup, true);
		var partition = EventHubsValidation.Partition(request.PartitionId);
		var position = request.Position;
		var start = EventHubsValidation.Position(position);
		var max = request.MaxEvents;
		var seconds = request.MaxSeconds;
		if (max is < 1 or > 100 || seconds is < 1 or > 300)
			throw new OperationException(OperationFailure.InvalidInput, "Use 1–100 events and 1–300 seconds.");
		var clock = Stopwatch.StartNew();
		using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(seconds));
		using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation, deadline.Token);
		var token = lifetime.Token;
		var bytes = 0L;
		var received = 0;
		List<EventSummary> items = [];
		var status = "completed";
		var reason = "count";
		string? detail = null, cleanupWarning = null;
		IEventHubReader? reader = null;
		long lastProgress = -1000;
		var statistics = new EventStatisticsCounter();
		async Task Progress(string phase, bool force = false)
		{
			if (!force && clock.ElapsedMilliseconds - lastProgress < 250)
				return;
			lastProgress = clock.ElapsedMilliseconds;
			try
			{
				await emit(new EventHubReadProgress(id, received, max, clock.ElapsedMilliseconds, phase, statistics.Snapshot()));
			}
			catch { }
		}
		try
		{
			await Progress("opening", true);
			token.ThrowIfCancellationRequested();
			reader = gateway!.OpenReader(hub, group, partition, start);
			store.Clear();
			while (received < max)
			{
				token.ThrowIfCancellationRequested();
				var remaining = TimeSpan.FromSeconds(seconds) - clock.Elapsed;
				if (remaining <= TimeSpan.Zero)
				{
					status = "limited";
					reason = "time";
					break;
				}
				await Progress("reading");
				var batch = await statistics.Measure(() => reader.ReadAsync(remaining < TimeSpan.FromSeconds(2) ? remaining : TimeSpan.FromSeconds(2), token), b => b.Count == 0);
				if (batch.Count > 1)
					throw new OperationException(OperationFailure.ReceiverContractViolation, "Reader exceeded the requested batch size. Reading stopped.");
				foreach (var item in batch)
				{
					received++;
					ReadOnlyMemory<byte> body = ReadOnlyMemory<byte>.Empty;
					string? warning = null;
					try
					{
						body = item.EventBody.ToMemory();
					}
					catch (Exception error) when (error is NotSupportedException or InvalidOperationException) { warning = "Unsupported AMQP body; bytes could not be retained."; }
					if (body.Length + bytes > Budget)
						warning = "Event body exceeds the remaining 64 MiB inspection budget.";
					var snapshotId = warning is null ? Guid.NewGuid().ToString() : null;
					var summary = new EventSummary(snapshotId, Number(item.SequenceNumber), item.OffsetString, Timestamp(item.EnqueuedTime),
						item.PartitionKey is { Length: > 256 } key ? key[..256] : item.PartitionKey, body.Length, warning);
					items.Add(summary);
					if (snapshotId is not null)
					{
						var appProperties = Properties(item.Properties, out var appWarning);
						var systemProperties = Properties(item.SystemProperties, out var systemWarning);
						store.Snapshots.Add(snapshotId, (summary, body, new(summary, appProperties, systemProperties,
							appWarning || systemWarning || item.MessageId?.Length > 256 || item.ContentType?.Length > 256 || item.CorrelationId?.Length > 256 ? "Some properties were truncated or omitted to fit the inspection limit." : null,
							Clip(item.MessageId), Clip(item.ContentType), Clip(item.CorrelationId))));
						store.Origins.Add(snapshotId, (connection!.Namespace, hub, group, partition));
						bytes += body.Length;
						statistics.Body(body.Length);
					}
					if (warning is not null)
					{
						status = "limited";
						reason = "buffer-limit";
					}
				}
				await Progress("reading");
				if (received >= max || reason == "buffer-limit")
					break;
				if (batch.Count == 0)
					await Task.Delay(100, token);
			}
		}
		catch (OperationCanceledException) when (token.IsCancellationRequested)
		{
			status = cancellation.IsCancellationRequested ? "cancelled" : "limited";
			reason = cancellation.IsCancellationRequested ? "cancelled" : "time";
		}
		catch (Exception error)
		{
			status = "failed";
			reason = "error";
			detail = error is OperationException protocol ? protocol.Message : connection?.Service == "iot-hub" ? "IoT Hub reading failed. Check the current compatible endpoint, ServiceConnect permission, consumer group and connectivity. No read was retried." : "Event reading failed. Check the hub, consumer group, partition, Listen/Data Receiver permission and connection. No read was retried.";
		}
		finally
		{
			await Progress("closing", true);
			if (reader is not null && !await cleanup.CloseAsync(reader))
			{
				cleanupWarning = "Receiver cleanup could not be confirmed. Disconnect before another read; a backend restart may be required.";
				status = "failed";
			}
		}
		var stop = reason switch
		{
			"count" => "Event limit reached.",
			"time" => "Time limit reached; this does not prove the partition is empty.",
			"cancelled" => "Cancelled.",
			"buffer-limit" => "Inspection buffer limit reached.",
			_ => detail
		};
		var result = new EventHubReadResult(id, hub, group, partition, position, status, reason, received, clock.ElapsedMilliseconds, items,
			$"{received} events read. {stop} No events were deleted and no checkpoints were saved.", cleanupWarning, statistics.Snapshot());
		reads.Add(id, (stamp, result));
		await Progress("finished", true);
		return result;
	}
}
