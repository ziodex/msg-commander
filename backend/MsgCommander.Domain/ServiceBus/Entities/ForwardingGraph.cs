using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.ServiceBus.Entities;

public sealed record ForwardingRoute(string Key, string Kind, string Name, string? TopicName, string? ForwardTo, string? ForwardDeadLetteredMessagesTo);

public static class ForwardingGraph
{
	public static void Validate(IReadOnlyList<ForwardingRoute> routes)
	{
		var links = routes.Where(route => !string.IsNullOrEmpty(route.ForwardTo) || !string.IsNullOrEmpty(route.ForwardDeadLetteredMessagesTo)).ToArray();
		HashSet<string> visiting = new(StringComparer.Ordinal);
		void Visit(ForwardingRoute route, int depth)
		{
			if (depth > 4 || !visiting.Add(route.Key))
				throw new DomainRuleException("Forwarding contains a cycle or exceeds four hops. Correct the configuration before importing.");
			foreach (var destination in new[] { route.ForwardTo, route.ForwardDeadLetteredMessagesTo }.Where(value => !string.IsNullOrEmpty(value)))
				foreach (var next in links.Where(next =>
					next.Kind == "queue" && string.Equals(next.Name, destination, StringComparison.OrdinalIgnoreCase) ||
					next.Kind == "subscription" && string.Equals(next.TopicName, destination, StringComparison.OrdinalIgnoreCase)))
					Visit(next, depth + 1);
			visiting.Remove(route.Key);
		}
		foreach (var route in links)
			Visit(route, 1);
	}
}
