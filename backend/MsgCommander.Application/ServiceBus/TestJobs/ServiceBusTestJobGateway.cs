using MsgCommander.Application.ServiceBus.TestJobs;
using MsgCommander.Contracts.ServiceBus.TestJobs;
using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Contracts.ServiceBus.Entities;

namespace MsgCommander.Application.ServiceBus.TestJobs;

// Binds a test job to messaging ports and its connection-owned deferred references and snapshots.
public sealed class ServiceBusTestJobGateway(IServiceBusMessagingGateway gateway, Func<bool> hasReceiver,
	Func<TestJobTarget, string, long, string?> recordDeferred, Action invalidateSnapshots, Func<Exception, Exception> translateFailure) : ITestJobGateway
{
	public bool HasOwnedReceiver => hasReceiver();
	private static EntityTarget Target(TestJobTarget target) => new(target.Kind, target.Name, target.TopicName);
	private Exception Translate(Exception error) => error is OperationException protocol
		? new TestJobException(TestJobError.InvalidRequest, protocol.Message) : translateFailure(error);
	public async Task<bool?> RequiresSessionAsync(TestJobTarget target, CancellationToken cancellation)
	{
		try
		{
			return (await gateway.GetEntityAsync(Target(target), cancellation)).Entity.RequiresSession;
		}
		catch (Exception error) { throw Translate(error); }
	}
	public ITestMessageSender OpenSender(TestJobTarget target)
	{
		try
		{
			return new Sender(gateway.OpenTestSender(Target(target)), Translate);
		}
		catch (Exception error) { throw Translate(error); }
	}
	public async Task<ITestJobReceiver> OpenReceiverAsync(TestJobTarget target, string sessionId, CancellationToken cancellation)
	{
		try
		{
			return new MessageTestJobReceiver(await gateway.OpenReceiverAsync(Target(target), "active", sessionId, cancellation), Translate);
		}
		catch (Exception error) { throw Translate(error); }
	}
	public string? RecordDeferred(TestJobTarget target, string sessionId, long sequence) => recordDeferred(target, sessionId, sequence);
	public void InvalidateSnapshots() => invalidateSnapshots();
	private sealed class Sender(ITestMessageSender sender, Func<Exception, Exception> translateFailure) : ITestMessageSender
	{
		public async Task SendBatchAsync(IReadOnlyList<TestJobMessage> messages, Action<int, int> dispatching,
			Action<int, int, double> acknowledged, CancellationToken cancellation)
		{
			try
			{
				await sender.SendBatchAsync(messages, dispatching, acknowledged, cancellation);
			}
			catch (Exception error) { throw translateFailure(error); }
		}
		public ValueTask DisposeAsync() => sender.DisposeAsync();
	}
}
