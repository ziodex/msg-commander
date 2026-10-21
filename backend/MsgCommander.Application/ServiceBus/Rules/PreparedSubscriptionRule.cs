using System.Collections.ObjectModel;
using MsgCommander.Contracts.ServiceBus.Rules;

namespace MsgCommander.Application.ServiceBus.Rules;

public sealed class PreparedSubscriptionRule
{
	internal PreparedSubscriptionRule(RuleDefinition definition, Dictionary<string, object> filterParameters,
		Dictionary<string, object> correlationProperties, Dictionary<string, object> actionParameters)
	{
		Definition = definition;
		FilterParameters = new ReadOnlyDictionary<string, object>(filterParameters);
		CorrelationProperties = new ReadOnlyDictionary<string, object>(correlationProperties);
		ActionParameters = new ReadOnlyDictionary<string, object>(actionParameters);
	}
	public RuleDefinition Definition
	{
		get;
	}
	public IReadOnlyDictionary<string, object> FilterParameters
	{
		get;
	}
	public IReadOnlyDictionary<string, object> CorrelationProperties
	{
		get;
	}
	public IReadOnlyDictionary<string, object> ActionParameters
	{
		get;
	}
}
