using Azure.Core.Amqp;
using Azure.Messaging.ServiceBus;
using MsgCommander.Host.Transport;

static class MessagingBoundaryChecks
{
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	static async Task Expired(Func<Task> action)
	{
		try
		{
			await action();
		}
		catch (OperationException error) when (error.Failure == OperationFailure.DeliveryExpired) { return; }
		throw new Exception("An unowned or consumed delivery reached settlement");
	}
	sealed class Client : ServiceBusClient
	{
		public int Disposals;
		public override ValueTask DisposeAsync()
		{
			Disposals++;
			return ValueTask.CompletedTask;
		}
	}
	sealed class Receiver(ServiceBusReceiveMode mode = ServiceBusReceiveMode.PeekLock) : ServiceBusReceiver
	{
		public readonly ServiceBusReceivedMessage Message = ServiceBusModelFactory.ServiceBusReceivedMessage(
			body: new BinaryData(new byte[] { 0, 255, 65 }), messageId: "owned", sequenceNumber: 9007199254740993L);
		public int Settlements, Renewals, Disposals;
		public TaskCompletionSource? Entered, Finish;
		public override ServiceBusReceiveMode ReceiveMode => mode;
		public override Task<IReadOnlyList<ServiceBusReceivedMessage>> ReceiveMessagesAsync(int maxMessages, TimeSpan? maxWaitTime = null, CancellationToken cancellationToken = default) =>
			Task.FromResult<IReadOnlyList<ServiceBusReceivedMessage>>([Message]);
		public override async Task CompleteMessageAsync(ServiceBusReceivedMessage message, CancellationToken cancellationToken = default)
		{
			Assert(ReferenceEquals(message, Message), "Settle the actual SDK delivery");
			Settlements++;
			Entered?.TrySetResult();
			if (Finish is not null)
				await Finish.Task;
		}
		public override Task RenewMessageLockAsync(ServiceBusReceivedMessage message, CancellationToken cancellationToken = default)
		{
			Renewals++;
			return Task.CompletedTask;
		}
		public override ValueTask DisposeAsync()
		{
			Disposals++;
			return ValueTask.CompletedTask;
		}
	}
	public static async Task<int> Run()
	{
		var session = new OutgoingMessage(new byte[] { 0, 255, 65 }) { MessageId = "session-only", SessionId = "one" };
		var sent = AzureOutgoingMessage.ToSdk(session);
		Assert(sent.SessionId == "one" && sent.PartitionKey is null && sent.GetRawAmqpMessage().Header.TimeToLive is null,
			"Session-only messages keep an absent partition key and entity-default TTL");
		Assert(sent.Body.ToMemory().Span.SequenceEqual(new byte[] { 0, 255, 65 }), "Keep binary body bytes");
		var raw = new AmqpAnnotatedMessage(AmqpMessageBody.FromValue("native value"));
		raw.Properties.MessageId = new AmqpMessageId("original");
		raw.Properties.ContentEncoding = "utf-8";
		raw.Header.Priority = 7;
		raw.ApplicationProperties["exact"] = long.MaxValue;
		raw.ApplicationProperties["Diagnostic-Id"] = "previous-hop";
		raw.ApplicationProperties["DeadLetterReason"] = "old-reason";
		raw.Footer["preserve"] = "footer";
		var original = AzureReceivedMessage.Snapshot(ServiceBusReceivedMessage.FromAmqpMessage(raw, new BinaryData(Guid.NewGuid().ToByteArray())));
		var copy = AzureOutgoingMessage.ToSdk(OutgoingMessages.Replay(original, "new", "copy"));
		var copied = copy.GetRawAmqpMessage();
		Assert(copied.Body.TryGetValue(out var body) && Equals(body, "native value") && copied.Properties.ContentEncoding == "utf-8" && copied.Header.Priority == 7 && Equals(copied.Footer["preserve"], "footer"),
			"Replay preserves a native AMQP value body and unmapped native headers/footer");
		Assert((long)copy.ApplicationProperties["exact"] == long.MaxValue && !copy.ApplicationProperties.ContainsKey("Diagnostic-Id") && !copy.ApplicationProperties.ContainsKey("DeadLetterReason"),
			"Retain exact typed properties and the SDK's omission of previous-hop diagnostics");

		var sdk = new Receiver();
		var client = new Client();
		await using var receiver = new AzureMessageReceiver(client, sdk);
		await using var other = new AzureMessageReceiver(new Client(), new Receiver());
		var delivery = (await receiver.ReceiveAsync(1, TimeSpan.FromSeconds(1), default))[0];
		Assert(delivery.SequenceNumber == 9007199254740993L, "Keep Int64 precision across the messaging port");
		await Expired(() => other.SettleAsync(delivery, "complete", "", "", default));
		await Expired(() => receiver.SettleAsync(AzureReceivedMessage.Snapshot(sdk.Message), "complete", "", "", default));
		Assert(sdk.Settlements == 0, "Foreign deliveries and peek snapshots never dispatch");
		await receiver.SettleAsync(delivery, "renew", "", "", default);
		sdk.Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
		sdk.Finish = new(TaskCreationOptions.RunContinuationsAsynchronously);
		var first = receiver.SettleAsync(delivery, "complete", "", "", default);
		await sdk.Entered.Task;
		var duplicate = Expired(() => receiver.SettleAsync(delivery, "complete", "", "", default));
		sdk.Finish.SetResult();
		await Task.WhenAll(first, duplicate);
		Assert(sdk.Settlements == 1 && sdk.Renewals == 1, "Renew keeps ownership, concurrent completion cannot dispatch twice");
		await Expired(() => receiver.SettleAsync(delivery, "complete", "", "", default));
		await receiver.DisposeAsync();
		await receiver.DisposeAsync();
		Assert(sdk.Disposals == 1 && client.Disposals == 1, "Release the owned SDK endpoints exactly once");
		await Expired(() => receiver.SettleAsync(delivery, "complete", "", "", default));
		await using var consumed = new AzureMessageReceiver(new Client(), new Receiver(ServiceBusReceiveMode.ReceiveAndDelete));
		var deleted = (await consumed.ReceiveAsync(1, TimeSpan.FromSeconds(1), default))[0];
		await Expired(() => consumed.SettleAsync(deleted, "complete", "", "", default));

		var expected = new[] { -32602, -32601, -32000, -32001, -32004, -32002, -32003, -32010, -32011, -32012, -32013,
			-32020, -32021, -32022, -32030, -32031, -32040, -32041, -32042, -32043, -32044, -32050 };
		Assert(Enum.GetValues<OperationFailure>().Select(OperationProtocolErrors.Code).SequenceEqual(expected), "Preserve every existing protocol error number at the Host boundary");
		Console.WriteLine("Messaging boundary checks passed");
		return 0;
	}
}
