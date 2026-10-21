using System.Text.Json;
using System.Xml.Linq;
using Azure;
using Azure.Messaging.ServiceBus.Administration;
using static MsgCommander.Application.ServiceBus.Rules.SubscriptionRules;

namespace MsgCommander.Infrastructure.ServiceBus;

public sealed partial class AzureServiceBusGateway
{
	private static string FilterType(RuleFilter filter) => filter switch { TrueRuleFilter => "true", FalseRuleFilter => "false", SqlRuleFilter => "sql", CorrelationRuleFilter => "correlation", _ => "unsupported" };
	private static PropertyValue[] RuleProperties(IDictionary<string, object> values) => values.OrderBy(v => v.Key, StringComparer.Ordinal).Select(v => MsgCommander.Application.Common.DisplayValues.Property(v.Key, v.Value)).ToArray();
	private static RuleConfiguration ProjectRule(Response<RuleProperties> response)
	{
		var rule = response.Value;
		var type = FilterType(rule.Filter);
		var sql = type == "sql" ? (SqlRuleFilter)rule.Filter : null;
		var c = rule.Filter as CorrelationRuleFilter;
		var action = rule.Action as SqlRuleAction;
		var definition = new RuleDefinition(type, sql?.SqlExpression ?? "", sql is null ? [] : RuleProperties(sql.Parameters),
			c is null ? null : new(c.CorrelationId, c.MessageId, c.Subject, c.ContentType, c.To, c.ReplyTo, c.SessionId, c.ReplyToSessionId, RuleProperties(c.ApplicationProperties)),
			action?.SqlExpression ?? "", action is null ? [] : RuleProperties(action.Parameters));
		// The SDK can coerce unknown XML value types to strings and drop unknown action fields.
		// Inspect the raw response before allowing edits, rather than silently rewriting those values.
		var xml = XDocument.Parse(response.GetRawResponse().Content.ToString());
		var wire = xml.Descendants().First(e => e.Name.LocalName == "RuleDescription");
		var readOnly = UnsupportedWire(wire) ? "This rule contains XML fields or types that this editor cannot preserve. Editing is disabled; deletion still requires confirmation." : null;
		try
		{
			AzureSubscriptionRules.Build(definition);
		}
		catch (Exception e) when (e is OperationException or ArgumentException) { readOnly = "This rule contains values outside the editor's supported types or limits. Editing is disabled to prevent data loss."; }
		// Do not display SDK-coerced values as their original types, or exceed the bounded DTO.
		// The revision still includes the full wire definition, allowing an explicit guarded delete.
		if (readOnly is not null)
			definition = new("unsupported", "", [], null, "", []);
		var result = Configuration(rule.Name, definition, readOnly, wire.ToString(SaveOptions.DisableFormatting));
		if (JsonSerializer.SerializeToUtf8Bytes(result).Length > 250_000)
			throw new OperationException(OperationFailure.InspectionLimit, "Rule configuration exceeds the 250 KB editor limit.");
		return result;
	}
	private static bool UnsupportedWire(XElement rule)
	{
		XNamespace xsi = "http://www.w3.org/2001/XMLSchema-instance";
		XNamespace xsd = "http://www.w3.org/2001/XMLSchema";
		if (rule.Elements().Any(e => e.Name.LocalName is not ("Name" or "Filter" or "Action" or "CreatedAt")))
			return true;
		foreach (var part in rule.Elements().Where(e => e.Name.LocalName is "Filter" or "Action"))
		{
			var type = (string?)part.Attribute(xsi + "type");
			var fields = type switch
			{
				"SqlFilter" or "TrueFilter" or "FalseFilter" or "SqlRuleAction" => new[] { "SqlExpression", "Parameters" },
				"CorrelationFilter" => ["CorrelationId", "MessageId", "To", "ReplyTo", "Label", "SessionId", "ReplyToSessionId", "ContentType", "Properties"],
				"EmptyRuleAction" => [],
				_ => null
			};
			if (fields is null || part.Elements().Any(e => !fields.Contains(e.Name.LocalName) &&
				!(e.Name.LocalName == "CompatibilityLevel" && e.Value == "20") &&
				!(e.Name.LocalName == "RequiresPreprocessing" && e.Value is "true" or "false")))
				return true;
		}
		foreach (var value in rule.Descendants().Where(e => e.Name.LocalName == "Value"))
		{
			var type = ((string?)value.Attribute(xsi + "type"))?.Split(':');
			if (type is not { Length: 2 } || value.GetNamespaceOfPrefix(type[0]) != xsd || type[1] is not ("string" or "boolean" or "int" or "long" or "double" or "dateTime" or "duration"))
				return true;
		}
		return false;
	}
	public async Task<RulePage> ListRulesAsync(EntityTarget target, string? continuation, CancellationToken cancellation)
	{
		Target(target);
		await foreach (var page in admin.GetRulesAsync(target.TopicName, target.Name, cancellation).AsPages(continuation, 100).WithCancellation(cancellation))
			return new(page.Values.Select(rule => new RuleSummary(rule.Name, FilterType(rule.Filter), rule.Action is not null)).ToArray(), page.ContinuationToken);
		return new([], null);
	}
	public async Task<RuleConfiguration> GetRuleAsync(EntityTarget target, string name, CancellationToken cancellation)
	{
		Target(target, name);
		return ProjectRule(await admin.GetRuleAsync(target.TopicName, target.Name, name, cancellation));
	}
	public async Task ChangeRuleAsync(string action, EntityTarget target, string name, RuleDefinition? definition, string? expectedRevision, Action dispatching, CancellationToken cancellation)
	{
		Target(target, name);
		if (action is not ("create" or "update" or "delete"))
			throw new OperationException(OperationFailure.InvalidInput, "Unsupported rule action.");
		var built = action == "delete" ? default : AzureSubscriptionRules.Build(definition ?? throw new OperationException(OperationFailure.InvalidInput, "Rule definition is required."));
		if (action == "create")
		{
			var options = new CreateRuleOptions(name, built.Filter) { Action = built.Action };
			cancellation.ThrowIfCancellationRequested();
			dispatching();
			await admin.CreateRuleAsync(target.TopicName, target.Name, options, cancellation);
			return;
		}
		var response = await admin.GetRuleAsync(target.TopicName, target.Name, name, cancellation);
		var current = ProjectRule(response);
		CheckRevision(current, expectedRevision);
		if (action == "update")
		{
			if (current.ReadOnlyReason is not null)
				throw new OperationException(OperationFailure.InvalidInput, current.ReadOnlyReason);
			response.Value.Filter = built.Filter;
			response.Value.Action = built.Action;
		}
		cancellation.ThrowIfCancellationRequested();
		dispatching();
		if (action == "delete")
			await admin.DeleteRuleAsync(target.TopicName, target.Name, name, cancellation);
		else
			await admin.UpdateRuleAsync(target.TopicName, target.Name, response.Value, cancellation);
	}
}
