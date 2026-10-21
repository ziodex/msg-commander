using MsgCommander.Application.ServiceBus.Messages;
using MsgCommander.Application.ServiceBus.Authorization;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Rules;
using MsgCommander.Contracts.ServiceBus.Authorization;

namespace MsgCommander.Application.ServiceBus.Gateways;

// Read and write methods remain explicit; settlement is isolated in a receiver lease.
public interface IServiceBusGateway : IServiceBusMessagingGateway, IServiceBusAdministrationGateway;

public interface IServiceBusAdministrationGateway : IEntityReader
{
	Task<RuntimePage> ListRuntimeAsync(string kind, string? topicName, string? continuationToken, CancellationToken cancellation);
	Task<EntityCopyState> GetEntityCopyStateAsync(EntityTarget target, CancellationToken cancellation);
	Task<bool> EntityExistsAsync(EntityTarget target, CancellationToken cancellation);
	Task CreateEntityCopyAsync(EntityTarget target, EntitySettings settings, string guardRule, Action dispatching, CancellationToken cancellation);
	Task<RulePage> ListRulesAsync(EntityTarget target, string? continuation, CancellationToken cancellation);
	Task<RuleConfiguration> GetRuleAsync(EntityTarget target, string name, CancellationToken cancellation);
	Task ChangeRuleAsync(string action, EntityTarget target, string name, RuleDefinition? definition, string? expectedRevision, Action dispatching, CancellationToken cancellation);
	Task<EntityPage> ListAsync(string kind, string? topicName, string? continuationToken, CancellationToken cancellation);
	Task<EntityConfiguration> GetEntityConfigurationAsync(EntityTarget target, CancellationToken cancellation);
	Task ChangeEntityAsync(string action, EntityTarget target, EntitySettings? settings, string? expectedRevision, Action dispatching, CancellationToken cancellation);
}
public interface IServiceBusGatewayFactory : IAuthorizationGatewayFactory
{
	Task<IServiceBusGateway> ConnectAsync(ConnectionProfile profile, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation);
}
