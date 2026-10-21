using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.ResourceConfiguration;

public sealed record ImportDependencyStep(string Id, IReadOnlyList<string> DependsOn, int Priority, string ResourceKey);

public static class ImportDependencies
{
	public static IReadOnlyList<string> Order(IReadOnlyList<ImportDependencyStep> steps)
	{
		if (steps.Select(step => step.Id).Distinct(StringComparer.Ordinal).Count() != steps.Count)
			throw new DomainRuleException("Import steps must have unique identities.");
		var remaining = steps.ToList();
		List<string> ordered = [];
		HashSet<string> completed = new(StringComparer.Ordinal);
		while (remaining.Count > 0)
		{
			var next = remaining.Where(step => step.DependsOn.All(completed.Contains))
				.OrderBy(step => step.Priority).ThenBy(step => step.ResourceKey, StringComparer.Ordinal).FirstOrDefault();
			if (next is null)
				throw new DomainRuleException("Import dependencies are missing or contain a cycle.");
			ordered.Add(next.Id);
			completed.Add(next.Id);
			remaining.Remove(next);
		}
		return ordered;
	}
}
