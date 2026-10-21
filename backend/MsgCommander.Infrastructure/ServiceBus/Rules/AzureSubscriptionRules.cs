using Azure.Messaging.ServiceBus.Administration;
using MsgCommander.Application.ServiceBus.Rules;
using MsgCommander.Contracts.ServiceBus.Rules;

namespace MsgCommander.Infrastructure.ServiceBus.Rules;

public static class AzureSubscriptionRules
{
	public static (RuleFilter Filter, RuleAction? Action) Build(RuleDefinition definition)
	{
		var prepared = SubscriptionRules.Prepare(definition);
		RuleFilter filter;
		if (definition.FilterType == "sql")
		{
			var sql = new SqlRuleFilter(definition.SqlExpression);
			foreach (var property in prepared.FilterParameters)
				sql.Parameters.Add(property.Key, property.Value);
			filter = sql;
		}
		else if (definition.FilterType == "correlation")
		{
			var c = definition.Correlation!;
			var correlation = new CorrelationRuleFilter
			{
				CorrelationId = c.CorrelationId,
				MessageId = c.MessageId,
				Subject = c.Subject,
				ContentType = c.ContentType,
				To = c.To,
				ReplyTo = c.ReplyTo,
				SessionId = c.SessionId,
				ReplyToSessionId = c.ReplyToSessionId
			};
			foreach (var property in prepared.CorrelationProperties)
				correlation.ApplicationProperties.Add(property.Key, property.Value);
			filter = correlation;
		}
		else
			filter = definition.FilterType == "true" ? new TrueRuleFilter() : new FalseRuleFilter();
		if (definition.ActionExpression.Length == 0)
			return (filter, null);
		var action = new SqlRuleAction(definition.ActionExpression);
		foreach (var property in prepared.ActionParameters)
			action.Parameters.Add(property.Key, property.Value);
		return (filter, action);
	}
}
