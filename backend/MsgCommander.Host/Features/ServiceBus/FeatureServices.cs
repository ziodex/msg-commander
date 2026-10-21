using MsgCommander.Application.ServiceBus.Workspace;
using MsgCommander.Application.ServiceBus.Administration;
using MsgCommander.Application.ServiceBus.Maintenance;
using MsgCommander.Application.ServiceBus.Sessions;

namespace MsgCommander.Host;

// Typed feature access during the Application owner's serialized operation.
public sealed partial class ServiceBusWorkspace
{
	private ServiceBusConnectionContext Context => owner.Current;
	private InteractiveReceiverService Interactive => Context.Interactive;
	private MessageInspectionService Inspection => Context.Inspection;
	private MessageSendingService Sending => Context.Sending;
	private SessionCatalogService Sessions => Context.Sessions;
	private MutationReceipts Receipts => Context.Receipts;
	private TestJobService TestJobs => Context.TestJobs;
	private EntityAdministrationService EntityAdministration => Context.EntityAdministration;
	private EntityBulkService EntityBulk => Context.EntityBulk;
	private EntityCopyService EntityCopies => Context.EntityCopies;
	private AuthorizationService Authorization => Context.Authorization;
	private MessagingConfigurationService Configuration => Context.Configuration;
	private PurgeService Purges => Context.Purges;
	private BulkPurgeService BulkPurges => Context.BulkPurges;
	private ReceiveDeleteService ReceiveDeletes => Context.ReceiveDeletes;
	private DeadLetterRecoveryService Recovery => Context.Recovery;
	private Task CloseReceiver() => Interactive.DisposeAsync().AsTask();
}
