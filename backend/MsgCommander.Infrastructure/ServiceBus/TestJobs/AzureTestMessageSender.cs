using System.Diagnostics;
using Azure.Messaging.ServiceBus;
using MsgCommander.Application.ServiceBus.TestJobs;

namespace MsgCommander.Infrastructure.ServiceBus.TestJobs;

public sealed class AzureTestMessageSender(ServiceBusSender sender) : ITestMessageSender
{
	public static ServiceBusMessage ToSdkMessage(TestJobMessage value)
	{
		var message = new ServiceBusMessage(new BinaryData(value.Body))
		{
			MessageId = value.MessageId,
			ContentType = value.ContentType.Length == 0 ? null : value.ContentType,
			SessionId = value.SessionId.Length == 0 ? null : value.SessionId
		};
		message.ApplicationProperties["commander-test-job"] = value.JobId;
		message.ApplicationProperties["commander-test-index"] = value.Index;
		return message;
	}
	public async Task SendBatchAsync(IReadOnlyList<TestJobMessage> messages, Action<int, int> dispatching,
		Action<int, int, double> acknowledged, CancellationToken cancellation)
	{
		try
		{
			var outgoing = messages.Select(ToSdkMessage).ToArray();
			var offset = 0;
			while (offset < outgoing.Length)
			{
				using var batch = await sender.CreateMessageBatchAsync(cancellation);
				var size = 0;
				while (offset + size < outgoing.Length && batch.TryAddMessage(outgoing[offset + size]))
					size++;
				if (size == 0)
					throw new TestJobException(TestJobError.InvalidRequest, "Test message exceeds the destination's message size limit.");
				cancellation.ThrowIfCancellationRequested();
				dispatching(offset, size);
				var start = Stopwatch.GetTimestamp();
				await sender.SendMessagesAsync(batch, cancellation);
				acknowledged(offset, size, Stopwatch.GetElapsedTime(start).TotalMilliseconds);
				offset += size;
			}
		}
		catch (Exception error) { throw TestJobFailureMapper.Translate(error); }
	}
	public ValueTask DisposeAsync() => sender.DisposeAsync();
}
