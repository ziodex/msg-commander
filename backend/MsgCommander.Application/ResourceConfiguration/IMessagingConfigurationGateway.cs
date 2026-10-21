using MsgCommander.Contracts.ResourceConfiguration;

namespace MsgCommander.Application.ResourceConfiguration;

public interface IMessagingConfigurationGateway
{
	string Service
	{
		get;
	}
	string Namespace
	{
		get;
	}
	string ContextKey
	{
		get;
	}
	Task<MessagingConfigSnapshot> Read(MessagingConfigTarget target, CancellationToken token);
	Task<IReadOnlyList<MessagingConfigResource>> Export(MessagingConfigTarget? scope, bool policies, CancellationToken token);
	Task<MessagingConfigResource> Prepare(MessagingConfigResource source, MessagingConfigSnapshot? current, CancellationToken token);
	Task Write(MessagingConfigResource resource, string phase, string action, MessagingConfigSnapshot? current, string? guard, Action dispatching, CancellationToken token);
	Task<IReadOnlyList<string>> RuleNames(MessagingConfigTarget target, CancellationToken token) => Task.FromResult<IReadOnlyList<string>>([]);
	Task VerifyRules(MessagingConfigTarget target, IReadOnlyList<MessagingConfigResource> intended, CancellationToken token) => Task.CompletedTask;
	Task<IReadOnlyList<MessagingConfigSnapshot>> ForwardingTree(MessagingConfigTarget target, CancellationToken token) => Task.FromResult<IReadOnlyList<MessagingConfigSnapshot>>([]);
}
