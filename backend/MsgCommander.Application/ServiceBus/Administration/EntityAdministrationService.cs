using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Application.ServiceBus.Gateways;
using MsgCommander.Application.ServiceBus.Rules;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Rules;

namespace MsgCommander.Application.ServiceBus.Administration;

public sealed class EntityAdministrationService(IServiceBusAdministrationGateway gateway, Func<EntityTarget?> receivedTarget, Action invalidateSnapshots)
{
	public async Task ChangeEntityAsync(EntityChange request, Action dispatching, CancellationToken cancellation)
	{
		EntityManagement.ValidateTarget(request.Target);
		if (request.Action is not ("create" or "update" or "delete"))
			throw new OperationException(OperationFailure.InvalidInput, "Unsupported entity action.");
		if (request.Action != "create" && EntityManagement.Affects(request.Target, receivedTarget()))
			throw new OperationException(OperationFailure.ReceiverInUse, "Close the receiver for this entity (or its subscription) before editing or deleting it. Settle any owned messages first.");
		if (request.Action == "delete" && request.Confirmation != EntityManagement.Path(request.Target))
			throw new OperationException(OperationFailure.InvalidInput, "Type the exact entity path to confirm deletion.");
		if (request.Action != "delete")
			EntityManagement.Validate(request.Target, request.Settings ?? throw new OperationException(OperationFailure.InvalidInput, "Missing entity settings."));
		await gateway.ChangeEntityAsync(request.Action, request.Target, request.Settings, request.ExpectedRevision,
			() => { dispatching(); invalidateSnapshots(); }, cancellation);
	}

	public async Task ChangeRuleAsync(RuleChange request, Action dispatching, CancellationToken cancellation)
	{
		SubscriptionRules.Target(request.Target, request.Name);
		if (request.Action is not ("create" or "update" or "delete"))
			throw new OperationException(OperationFailure.InvalidInput, "Unsupported rule action.");
		if (request.Action == "delete" && request.Confirmation != SubscriptionRules.Path(request.Target, request.Name))
			throw new OperationException(OperationFailure.InvalidInput, "Type the exact rule path to confirm deletion.");
		if (request.Action != "delete")
			SubscriptionRules.Validate(request.Definition ?? throw new OperationException(OperationFailure.InvalidInput, "Missing rule definition."));
		await gateway.ChangeRuleAsync(request.Action, request.Target, request.Name, request.Definition, request.ExpectedRevision, dispatching, cancellation);
	}
}
