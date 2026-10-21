using MsgCommander.Application.Common;
using MsgCommander.Application.Connections;
using MsgCommander.Application.ResourceConfiguration;
using MsgCommander.Application.ServiceBus.Administration;
using MsgCommander.Application.ServiceBus.Authorization;
using MsgCommander.Application.ServiceBus.Configuration;
using MsgCommander.Application.ServiceBus.Gateways;
using MsgCommander.Application.ServiceBus.Listeners;
using MsgCommander.Application.ServiceBus.Maintenance;
using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Application.ServiceBus.Sessions;
using MsgCommander.Application.ServiceBus.TestJobs;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Listeners;
using MsgCommander.Contracts.ServiceBus.TestJobs;
using MsgCommander.Domain.ServiceBus.TestJobs;

namespace MsgCommander.Application.ServiceBus.Workspace;

/// <summary>One connection generation's feature state. Foreground operations use the owner's gate.</summary>
public sealed class ServiceBusConnectionContext : IAsyncDisposable
{
	private readonly IServiceBusGateway gateway;
	private readonly string profileId, namespaceName;
	private readonly ServiceBusFailurePolicies failures;
	private readonly DeferredReferenceService deferred;
	private readonly Action cleanupFailed;
	private readonly ListenerCoordinator listeners;
	private NamespaceConnection? connection;
	private int disposed;
	public NamespaceConnection Connection => connection ?? throw new InvalidOperationException("Connection has not been published.");
	public IServiceBusGateway Gateway
	{
		get
		{
			RequireActive();
			return gateway;
		}
	}
	public DeviceCodePrompts Prompts
	{
		get;
	}
	public InteractiveReceiverService Interactive
	{
		get;
	}
	public MessageInspectionService Inspection
	{
		get;
	}
	public MessageSendingService Sending
	{
		get;
	}
	public SessionCatalogService Sessions
	{
		get;
	}
	public MutationReceipts Receipts
	{
		get;
	}
	public TestJobService TestJobs { get; } = new();
	public EntityAdministrationService EntityAdministration
	{
		get;
	}
	public EntityBulkService EntityBulk
	{
		get;
	}
	public EntityCopyService EntityCopies
	{
		get;
	}
	public AuthorizationService Authorization
	{
		get;
	}
	public MessagingConfigurationService Configuration
	{
		get;
	}
	public PurgeService Purges
	{
		get;
	}
	public BulkPurgeService BulkPurges
	{
		get;
	}
	public ReceiveDeleteService ReceiveDeletes
	{
		get;
	}
	public DeadLetterRecoveryService Recovery
	{
		get;
	}
	public IMessageListener? Listener => listeners.Current;

	public ServiceBusConnectionContext(IServiceBusGateway gateway, IServiceBusGatewayFactory factory, string profileId,
		string namespaceName, ServiceBusFailurePolicies failures, DeferredReferenceService deferred,
		DeviceCodePrompts prompts, Action cleanupFailed)
	{
		this.gateway = gateway;
		this.profileId = profileId;
		this.namespaceName = namespaceName;
		this.failures = failures;
		this.deferred = deferred;
		this.cleanupFailed = cleanupFailed;
		Prompts = prompts;
		listeners = new(failures.Messaging);
		Interactive = new(gateway, failures.Messaging,
			(target, subQueue, session, sequence) => deferred.Acknowledge(DeferScope(target, subQueue, session), sequence),
			(target, subQueue, session, sequence) => deferred.Record(DeferScope(target, subQueue, session), sequence));
		ReceiveDeletes = new(gateway, namespaceName, () => Interactive.HasReceiver, failures.Maintenance);
		Inspection = new(gateway, id => ReceiveDeletes.FindSnapshot(id) ?? Listener?.Inspect(id) ?? Interactive.FindSnapshot(id));
		Sending = new(gateway, Inspection);
		Sessions = new(gateway);
		Receipts = new(failures.Mutations);
		EntityAdministration = new(gateway, () => Interactive.Target, Inspection.Clear);
		EntityBulk = new(gateway, namespaceName, () => Interactive.HasReceiver, Inspection.Clear, failures.Administration);
		EntityCopies = new(gateway, namespaceName, () => Interactive.Target, Inspection.Clear, failures.Administration);
		Authorization = new(factory, namespaceName);
		Configuration = new(new ServiceBusConfigurationGateway(gateway, namespaceName, () => Authorization.Gateway,
			() => Connection.ConnectionId + ":" + Authorization.Session?.AuthorizationId, failures.Configuration,
			() => Require(ServiceBusOperation.ConfigurationWrite)), failures.Configuration);
		Purges = new(gateway, namespaceName, () => Interactive.HasReceiver, Inspection.Clear, failures.Maintenance);
		BulkPurges = new(gateway, Purges, namespaceName, () => Interactive.HasReceiver);
		Recovery = new(gateway, async (profile, code, token) => await factory.ConnectAsync(profile, code, token),
			namespaceName, () => Interactive.HasReceiver, Inspection.Clear, failures.Maintenance);
	}
	internal NamespaceConnection Describe(string id) => connection = new(id, profileId, namespaceName, MsgCommander.Application.Common.DisplayValues.Timestamp(DateTimeOffset.UtcNow));
	public DeferredMessageScope DeferScope(EntityTarget target, string subQueue, string? sessionId) => new(profileId, namespaceName, target, subQueue, sessionId ?? "");
	private void RequireActive()
	{
		if (Volatile.Read(ref disposed) != 0)
			throw new OperationException(OperationFailure.ConnectionExpired, "Connection expired. Connect to the namespace again.");
	}
	public void Require(ServiceBusOperation operation)
	{
		RequireActive();
		if (operation == ServiceBusOperation.Shared)
			return;
		if (Listener?.Active == true)
			throw new OperationException(OperationFailure.OperationBlocked, operation == ServiceBusOperation.ConfigurationWrite
				? "Stop the listener before importing resource configuration."
				: "Stop the listener before receiving interactively, purging, replaying or changing entities and rules.");
		if (operation == ServiceBusOperation.ConfigurationWrite && Interactive.HasReceiver)
			throw new OperationException(OperationFailure.OperationBlocked, "Close the current message or session receiver before importing resource configuration.");
	}
	public Task<ListenerState> StartListenerAsync(ListenerStart request, string fingerprint, CancellationToken cancellation)
	{
		RequireActive();
		var scope = DeferScope(request.Target, "active", null);
		return listeners.StartAsync(Connection.ConnectionId, request, fingerprint, gateway, Interactive.HasReceiver,
			(sequence, session) => deferred.Record(scope with { SessionId = session ?? "" }, sequence), cancellation);
	}
	public async Task<TestJobResult> RunTestAsync(TestJobRequest request, string fingerprint, Func<TestJobProgress, Task> emit, CancellationToken cancellation)
	{
		Require(ServiceBusOperation.ExclusiveMessaging);
		var adapter = new ServiceBusTestJobGateway(gateway, () => Interactive.HasReceiver,
			(address, session, sequence) => deferred.Record(DeferScope(new(address.Kind, address.Name, address.TopicName), "active", session), sequence),
			Inspection.Clear, failures.TestJobs);
		try
		{
			return await TestJobs.RunAsync(request, fingerprint, adapter, emit, cancellation);
		}
		catch (TestJobRuleException error) { throw new OperationException(OperationFailure.InvalidInput, error.Message); }
		catch (TestJobException error)
		{
			throw new OperationException(error.Error switch
			{
				TestJobError.ResourceLimit => OperationFailure.OperationBlocked,
				TestJobError.ReceiverContract => OperationFailure.ReceiverContractViolation,
				_ => OperationFailure.InvalidInput
			}, error.Message);
		}
	}
	public async ValueTask DisposeAsync()
	{
		if (Interlocked.Exchange(ref disposed, 1) != 0)
			return;
		Prompts.Close();
		try
		{
			try
			{
				await listeners.ClearAsync();
			}
			finally
			{
				Inspection.Clear();
				TestJobs.Clear();
				Receipts.Clear();
				Purges.Clear();
				BulkPurges.Clear();
				ReceiveDeletes.Clear();
				Recovery.Clear();
				Configuration.Clear();
				EntityBulk.Clear();
				EntityCopies.Clear();
				Authorization.Clear();
				try
				{
					await Sessions.DisposeAsync();
				}
				finally { try { await Interactive.DisposeAsync(); } finally { await gateway.DisposeAsync(); } }
			}
		}
		catch { cleanupFailed(); throw; }
	}
}
