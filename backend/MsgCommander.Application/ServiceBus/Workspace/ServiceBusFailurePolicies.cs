using MsgCommander.Application.ResourceConfiguration;
using MsgCommander.Application.ServiceBus.Administration;
using MsgCommander.Application.ServiceBus.Maintenance;
using MsgCommander.Application.ServiceBus.Messages;

namespace MsgCommander.Application.ServiceBus.Workspace;

public sealed record ServiceBusFailurePolicies(IMessageFailureClassifier Messaging,
	IMessageMutationFailureClassifier Mutations, IMaintenanceFailureClassifier Maintenance,
	IAdministrationFailureClassifier Administration, IConfigurationFailureClassifier Configuration,
	Func<Exception, Exception> TestJobs);

public enum ServiceBusOperation
{
	Shared, ExclusiveMessaging, ConfigurationWrite
}
