using MsgCommander.Application.AccessPolicies;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.AccessPolicies;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.ServiceBus.Authorization;

namespace MsgCommander.Application.ServiceBus.Authorization;

/// <summary>A management session owned by one messaging connection. Calls require owner serialization.</summary>
public sealed class AuthorizationService(IAuthorizationGatewayFactory factory, string namespaceName)
{
	public IAuthorizationGateway? Gateway
	{
		get; private set;
	}
	public AuthorizationSession? Session
	{
		get; private set;
	}
	public void Clear()
	{
		Gateway = null;
		Session = null;
	}

	public async Task<AuthorizationSession> ConnectAsync(AuthorizationContext context, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation)
	{
		context.Validate(namespaceName);
		Gateway = null;
		Session = null;
		var candidate = await factory.ConnectAuthorizationAsync(context, deviceCode, cancellation);
		cancellation.ThrowIfCancellationRequested();
		Gateway = candidate;
		return Session = new(Guid.NewGuid().ToString(), context.ResourceId);
	}

	private IAuthorizationGateway Require(AuthorizationScope scope)
	{
		if (Gateway is null || Session?.AuthorizationId != scope.AuthorizationId)
			throw new OperationException(OperationFailure.ConnectionExpired, "Azure management sign-in expired. Connect management again.");
		scope.Target.Validate();
		return Gateway;
	}

	public Task<AuthorizationPage> ListAsync(AuthorizationScope scope, CancellationToken cancellation) => Require(scope).ListAsync(scope.Target, cancellation);
	public Task<AuthorizationRule> GetAsync(AuthorizationScope scope, string name, CancellationToken cancellation)
	{
		var gateway = Require(scope);
		AccessPolicyRules.ValidateName(name);
		return gateway.GetAsync(scope.Target, name, cancellation);
	}
	public Task<AuthorizationKey> KeyAsync(AuthorizationScope scope, string name, string keyType, CancellationToken cancellation)
	{
		var gateway = Require(scope);
		AccessPolicyRules.ValidateName(name);
		AccessPolicyRules.KeyType(keyType);
		return gateway.KeyAsync(scope.Target, name, keyType, cancellation);
	}
	public Task ChangeAsync(AuthorizationChange request, Action dispatching, CancellationToken cancellation)
	{
		var gateway = Require(request.Scope);
		AccessPolicyRules.ValidateName(request.Name);
		if (request.Action is not ("create" or "update" or "delete" or "regenerate"))
			throw new OperationException(OperationFailure.InvalidInput, "Unsupported SAS rule action.");
		if (request.Action == "regenerate")
			AccessPolicyRules.KeyType(request.KeyType);
		if ((request.Action is "update" or "delete" or "regenerate") && request.Confirmation !=
			AuthorizationRules.Confirmation(request.Action, Session!.ResourceId, request.Scope.Target, request.Name, request.KeyType))
			throw new OperationException(OperationFailure.InvalidInput, "Type the exact action, resource path and key slot shown to confirm the SAS change.");
		var rights = request.Action is "create" or "update" ? AccessPolicyRules.Rights(request.Rights) : null;
		return gateway.ChangeAsync(request.Action, request.Scope.Target, request.Name, rights, request.ExpectedRevision, request.KeyType, dispatching, cancellation);
	}
}
