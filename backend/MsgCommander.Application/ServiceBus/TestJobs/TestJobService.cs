using System.Diagnostics;
using System.Text;
using MsgCommander.Contracts.ServiceBus.TestJobs;
using MsgCommander.Domain.ServiceBus.TestJobs;

namespace MsgCommander.Application.ServiceBus.TestJobs;

public sealed class TestJobService
{
	private static string Number(long value) => value.ToString(System.Globalization.CultureInfo.InvariantCulture);
	private static TestLatencySummary Summarize(List<double> values)
	{
		var summary = LatencySummary.From(values);
		return new(summary.Samples, summary.MinMs, summary.MeanMs, summary.P50Ms, summary.P95Ms, summary.P99Ms, summary.MaxMs);
	}
	private readonly Dictionary<string, (string Fingerprint, TestJobResult Result)> testJobs = [];
	private sealed class TestWorker(int worker)
	{
		public int Worker = worker, Sent, Received, Completed, Settled, Abandoned, Deferred, DeadLettered, Redelivered, Uncertain, SendBatches, ReceiveCalls;
		public long ElapsedMs;
		public IReadOnlyList<string> UncertainMessageIds = [];
		public string? UncertainSequenceNumber;
		public TestWorkerResult Snapshot() => new(Worker, Sent, Received, Completed, Settled, Abandoned, Deferred, DeadLettered, Redelivered, Uncertain, ElapsedMs,
			SendBatches, ReceiveCalls, UncertainMessageIds, UncertainSequenceNumber);
	}
	public TestJobResult? GetResult(string operationId) => testJobs.TryGetValue(operationId, out var receipt) ? receipt.Result : null;
	public void Clear() => testJobs.Clear();

	// One instance belongs to a connection scope; the host serializes run/reset with its connection gate.
	public async Task<TestJobResult> RunAsync(TestJobRequest input, string fingerprint, ITestJobGateway gateway,
		Func<TestJobProgress, Task> emit, CancellationToken cancellation)
	{
		var id = input.Id;
		if (!Guid.TryParse(id, out _))
			throw new TestJobRuleException("Invalid test job ID.");
		if (testJobs.TryGetValue(id, out var prior))
		{
			if (prior.Fingerprint != fingerprint)
				throw new TestJobException(TestJobError.InvalidRequest, "Test job ID was already used for a different request.");
			return prior.Result;
		}
		if (testJobs.Count >= 100)
			throw new TestJobException(TestJobError.ResourceLimit, "The test job receipt limit is reached. Review results before reconnecting.");
		var target = input.Target;
		var mode = input.Mode;
		var count = input.MaxMessages;
		var seconds = input.MaxSeconds;
		var delay = input.DelayMs;
		var workers = input.Workers;
		var batchSize = input.BatchSize;
		var session = input.SessionId;
		var body = input.Body;
		var contentType = input.ContentType;
		var generator = input.Generator;
		var payloadGenerator = new PayloadGenerator(generator.Kind, generator.Seed, generator.SizeBytes);
		var settlement = input.Settlement;
		var deadLetterReason = input.DeadLetterReason;
		var deadLetterDescription = input.DeadLetterDescription;
		new TestJobDefinition(id, target.Kind, target.Name, target.TopicName, mode, count, seconds, delay, workers, batchSize,
			session, body, contentType, input.Acknowledged, payloadGenerator, settlement, deadLetterReason, deadLetterDescription).Validate();
		if (gateway.HasOwnedReceiver)
			throw new TestJobException(TestJobError.ResourceLimit, "Close the current message or session receiver before starting a test job.");

		var clock = Stopwatch.StartNew();
		using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(seconds));
		using var stopped = new CancellationTokenSource();
		using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellation, deadline.Token, stopped.Token);
		using var progressGate = new SemaphoreSlim(1);
		var token = lifetime.Token;
		var payload = Encoding.UTF8.GetBytes(body);
		var sync = new object();
		var states = Enumerable.Range(1, workers).Select(n => new TestWorker(n)).ToArray();
		var sendTimes = new List<double>();
		var receiveTimes = new List<double>();
		var completeTimes = new List<double>();
		var settleTimes = new List<double>();
		var sent = 0;
		var received = 0;
		var completed = 0;
		var uncertain = 0;
		var settled = 0;
		var abandoned = 0;
		var deferred = 0;
		var deadLettered = 0;
		var redelivered = 0;
		var seen = new HashSet<long>();
		var deferredSequences = new List<string>();
		string? referenceWarning = null;
		var redeliveryStop = false;
		var sendBatches = 0;
		var receiveCalls = 0;
		var activeWorkers = 0;
		var assigned = 0;
		var reserved = 0;
		var failed = false;
		string? lastId = null, lastSequence = null, detail = null, cleanupWarning = null;
		long lastProgress = -1000;
		async Task Progress(string phase, bool force = false)
		{
			await progressGate.WaitAsync();
			try
			{
				TestJobProgress progress;
				lock (sync)
				{
					if (!force && clock.ElapsedMilliseconds - lastProgress < 250)
						return;
					lastProgress = clock.ElapsedMilliseconds;
					progress = new(id, mode, count, workers, batchSize, activeWorkers, sent, received, completed, settled, abandoned, deferred, deadLettered, redelivered, uncertain,
						sendBatches, receiveCalls, clock.ElapsedMilliseconds, phase, settlement);
				}
				try
				{
					await emit(progress);
				}
				catch { }
			}
			finally { progressGate.Release(); }
		}
		static bool Rejected(Exception error) => error is TestJobRuleException or TestJobException or UnauthorizedAccessException or ArgumentException ||
			error is TestJobTransportException { Rejected: true };
		void Fail(Exception error, TestWorker? state, IReadOnlyList<string> inFlight, string? sequence)
		{
			lock (sync)
			{
				if (state is not null && inFlight.Count > 0 && !Rejected(error))
				{
					state.Uncertain = inFlight.Count;
					uncertain += inFlight.Count;
					state.UncertainMessageIds = inFlight;
					state.UncertainSequenceNumber = sequence;
				}
				if (error is not OperationCanceledException || !token.IsCancellationRequested)
				{
					failed = true;
					detail ??= error switch
					{
						TestJobException protocol => protocol.Message,
						TestJobRuleException rule => rule.Message,
						TestJobTransportException broker => broker.Message,
						_ => "Access or broker error. Nothing was retried."
					};
				}
			}
			stopped.Cancel();
		}
		async Task Worker(TestWorker state)
		{
			ITestMessageSender? sender = null;
			ITestJobReceiver? receiver = null;
			IReadOnlyList<string> inFlight = [];
			string? inFlightSequence = null;
			var workerClock = Stopwatch.StartNew();
			lock (sync)
				activeWorkers++;
			try
			{
				// Start every configured worker before a synchronously completed adapter can monopolize the job.
				await Task.Yield();
				token.ThrowIfCancellationRequested();
				if (mode == "send")
					sender = gateway.OpenSender(target);
				else
					receiver = await gateway.OpenReceiverAsync(target, session, token);
				while (true)
				{
					token.ThrowIfCancellationRequested();
					int amount, first;
					lock (sync)
					{
						amount = Math.Min(batchSize, count - (mode == "send" ? assigned : settled + reserved));
						first = assigned + 1;
						if (mode == "send")
							assigned += amount;
						else
							reserved += amount;
					}
					if (amount == 0)
						break;
					if (mode == "send")
					{
						var messages = Enumerable.Range(first, amount).Select(index =>
						{
							var generated = generator.Kind == "literal" ? new TestPayload(payload, contentType) : TestPayloads.Create(payloadGenerator, body, contentType, id, index, token);
							return new TestJobMessage(generated.Body, generated.ContentType, session, $"{id}-{index}", id, index);
						}).ToArray();
						await Progress("sending");
						await sender!.SendBatchAsync(messages, (offset, size) =>
						{
							lock (sync)
							{
								token.ThrowIfCancellationRequested();
								inFlight = messages.Skip(offset).Take(size).Select(m => m.MessageId).ToArray();
								lastId = inFlight[^1];
							}
						}, (offset, size, ms) =>
						{
							lock (sync)
							{
								inFlight = [];
								sent += size;
								state.Sent += size;
								sendBatches++;
								state.SendBatches++;
								lastId = messages[offset + size - 1].MessageId;
								sendTimes.Add(ms); // One sample per acknowledged SDK batch, not per message.
							}
						}, token);
					}
					else
					{
						try
						{
							if (receiver!.SessionLockedUntil is DateTimeOffset until && until < DateTimeOffset.UtcNow.AddSeconds(15))
								await receiver.RenewSessionLockAsync(token);
							await Progress("receiving");
							var remaining = TimeSpan.FromSeconds(seconds) - clock.Elapsed;
							if (remaining <= TimeSpan.Zero)
							{
								deadline.Cancel();
								token.ThrowIfCancellationRequested();
							}
							var start = Stopwatch.GetTimestamp();
							var batch = await receiver.ReceiveAsync(amount, remaining < TimeSpan.FromSeconds(2) ? remaining : TimeSpan.FromSeconds(2), token);
							var ms = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
							lock (sync)
							{
								received += batch.Count;
								state.Received += batch.Count;
								receiveCalls++;
								state.ReceiveCalls++;
								if (batch.Count > 0)
									receiveTimes.Add(ms);
							}
							if (batch.Count > amount)
								throw new TestJobException(TestJobError.ReceiverContract, "Receiver exceeded the reserved count. No completion was attempted.");
							foreach (var message in batch)
							{
								if (settlement == "abandon")
								{
									bool duplicate;
									lock (sync)
									{
										duplicate = !seen.Add(message.SequenceNumber);
										if (duplicate)
										{
											redelivered++;
											state.Redelivered++;
											redeliveryStop = true;
										}
									}
									if (duplicate)
									{
										stopped.Cancel();
										token.ThrowIfCancellationRequested();
									}
								}
								await Progress(settlement == "complete" ? "completing" : "settling");
								token.ThrowIfCancellationRequested();
								lock (sync)
								{
									inFlight = [message.MessageId ?? ""];
									inFlightSequence = Number(message.SequenceNumber);
									lastId = message.MessageId is { Length: > 128 } value ? value[..128] : message.MessageId;
									lastSequence = inFlightSequence;
								}
								start = Stopwatch.GetTimestamp();
								await receiver.SettleAsync(message, settlement, deadLetterReason, deadLetterDescription, token);
								lock (sync)
								{
									inFlight = [];
									inFlightSequence = null;
									settled++;
									state.Settled++;
									var timing = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
									settleTimes.Add(timing);
									switch (settlement)
									{
										case "complete":
											completed++;
											state.Completed++;
											completeTimes.Add(timing);
											break;
										case "abandon":
											abandoned++;
											state.Abandoned++;
											break;
										case "defer":
											deferred++;
											state.Deferred++;
											deferredSequences.Add(Number(message.SequenceNumber));
											break;
										case "dead-letter":
											deadLettered++;
											state.DeadLettered++;
											break;
									}
									// Release confirmed slots immediately so another worker cannot overshoot the shared limit.
									reserved--;
								}
								amount--;
								if (settlement == "defer")
								{
									var warning = gateway.RecordDeferred(target, session, message.SequenceNumber);
									if (warning is not null)
									{
										lock (sync)
											referenceWarning ??= warning;
										throw new TestJobException(TestJobError.ResourceLimit, warning);
									}
								}
							}
							if (batch.Count == 0)
								await Task.Delay(100, token);
						}
						finally { lock (sync) reserved -= amount; }
					}
					await Progress(delay > 0 ? "pacing" : mode == "send" ? "sending" : "receiving");
					lock (sync)
					{
						if (sent + settled >= count)
							break;
					}
					if (delay > 0)
						await Task.Delay(delay, token);
				}
			}
			catch (Exception error) { Fail(error, state, inFlight, inFlightSequence); }
			finally
			{
				try
				{
					if (sender is not null)
						await sender.DisposeAsync();
					if (receiver is not null)
						await receiver.DisposeAsync();
				}
				catch { lock (sync) { cleanupWarning = "Client cleanup could not be confirmed. Review the target before another job."; failed = true; } stopped.Cancel(); }
				lock (sync)
				{
					activeWorkers--;
					state.ElapsedMs = workerClock.ElapsedMilliseconds;
				}
			}
		}
		try
		{
			await Progress("opening", true);
			token.ThrowIfCancellationRequested();
			var requiresSession = await gateway.RequiresSessionAsync(target, token);
			if (requiresSession == true && session.Length == 0)
				throw new TestJobRuleException("Enter a session ID for this session-enabled entity.");
			if (mode == "receive" && requiresSession == false && session.Length > 0)
				throw new TestJobRuleException("This entity does not use sessions. Clear the session ID.");
			await Task.WhenAll(states.Select(Worker));
		}
		catch (Exception error) { Fail(error, null, [], null); }
		await Progress("closing", true);
		if (mode == "receive")
			gateway.InvalidateSnapshots();
		var reason = failed ? "error" : sent + settled >= count ? "message-limit" : cancellation.IsCancellationRequested ? "cancelled" : redeliveryStop ? "redelivery" : "time-limit";
		var status = uncertain > 0 ? "unknown" : failed ? "failed" : reason == "message-limit" ? "completed" : reason == "cancelled" ? "cancelled" : "limited";
		var stop = reason switch
		{
			"message-limit" => "Message target reached.",
			"time-limit" => "Time limit reached.",
			"cancelled" => "Cancelled.",
			"redelivery" => "Stopped on redelivery; no message was intentionally abandoned twice.",
			_ => detail ?? "Test job stopped."
		};
		if (uncertain > 0)
			stop += $" {uncertain} message outcome(s) are uncertain; nothing was retried.";
		var actionName = settlement switch
		{
			"complete" => "completions",
			"abandon" => "abandons",
			"defer" => "deferrals",
			_ => "dead-letters"
		};
		var summary = mode == "send" ? $"{sent} sends confirmed. {stop}" : $"{received} received; {settled} {actionName} confirmed. {stop}";
		var result = new TestJobResult(id, target, mode, session, count, seconds, delay, workers, batchSize, sent, received, completed, settled, abandoned, deferred, deadLettered, redelivered, uncertain,
			sendBatches, receiveCalls, clock.ElapsedMilliseconds,
			new(Summarize(sendTimes), Summarize(receiveTimes), Summarize(completeTimes), Summarize(settleTimes)),
			states.Select(s => s.Snapshot()).ToArray(), status, reason, lastId, lastSequence, summary, cleanupWarning,
			generator, settlement, deferredSequences, referenceWarning);
		testJobs.Add(id, (fingerprint, result));
		await Progress("finished", true);
		return result;
	}
}
