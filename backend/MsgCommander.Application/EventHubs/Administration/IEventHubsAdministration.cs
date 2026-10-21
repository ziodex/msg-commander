using MsgCommander.Contracts.AccessPolicies;
using MsgCommander.Contracts.EventHubs.Administration;

namespace MsgCommander.Application.EventHubs.Administration;

public interface IEventHubsAdministration
{
	Task<EventAdminContext> ContextAsync(CancellationToken cancellation);
	Task<EventAdminDetails> GetAsync(EventAdminTarget target, CancellationToken cancellation);
	Task<EventPolicyPage> PoliciesAsync(string hub, string? continuation, CancellationToken cancellation);
	Task<AuthorizationKey> KeyAsync(EventAdminTarget target, string keyType, CancellationToken cancellation);
	Task ChangeAsync(EventAdminChange change, Action dispatching, CancellationToken cancellation);
}
