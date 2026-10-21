using MsgCommander.Contracts.ServiceBus.Authorization;
using MsgCommander.Contracts.AccessPolicies;

namespace MsgCommander.Application.ServiceBus.Authorization;

public interface IAuthorizationGateway
{
	Task<AuthorizationPage> ListAsync(AuthorizationTarget target, CancellationToken cancellation);
	Task<AuthorizationRule> GetAsync(AuthorizationTarget target, string name, CancellationToken cancellation);
	Task<AuthorizationKey> KeyAsync(AuthorizationTarget target, string name, string keyType, CancellationToken cancellation);
	Task ChangeAsync(string action, AuthorizationTarget target, string name, IReadOnlyList<string>? rights, string? expectedRevision, string? keyType, Action dispatching, CancellationToken cancellation);
}
