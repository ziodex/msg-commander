using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Rules;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MsgCommander.Application.ServiceBus.Rules;

public static class SubscriptionRules
{
	public static string Path(EntityTarget target, string name) => $"{EntityManagement.Path(target)}/Rules/{name}";
	public static void Target(EntityTarget target, string? name = null)
	{
		EntityManagement.ValidateTarget(target);
		if (target.Kind != "subscription")
			throw new OperationException(OperationFailure.InvalidInput, "Rules belong to a topic subscription.");
		if (name is not null && (name.Length is < 1 or > 50 || !Regex.IsMatch(name, @"^[A-Za-z0-9_$][A-Za-z0-9._$-]*$")))
			throw new OperationException(OperationFailure.InvalidInput, "Rule names use 1–50 letters, numbers, '_', '$', '-' or '.', starting with a letter, number, '_' or '$'.");
	}
	public static RuleConfiguration Configuration(string name, RuleDefinition definition, string? readOnlyReason = null, string? wire = null) => new(name, definition,
		Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
		{
			name,
			definition,
			wire
		}))), readOnlyReason);
	public static void CheckRevision(RuleConfiguration current, string? expected)
	{
		if (current.Revision != expected)
			throw new OperationException(OperationFailure.RevisionConflict, "Rule changed since this form was opened. Reload the rule and review your changes.");
	}
	public static Dictionary<string, object> Properties(IReadOnlyList<PropertyValue> values, bool correlation)
	{
		if (values is null || values.Count > 32 || JsonSerializer.SerializeToUtf8Bytes(values).Length > 65536)
			throw new OperationException(OperationFailure.InvalidInput, "Use at most 32 properties/parameters and 64 KiB per group.");
		Dictionary<string, object> result = new(StringComparer.Ordinal);
		foreach (var p in values)
		{
			if (string.IsNullOrWhiteSpace(p.Name) || p.Name.Length > 128 || p.Value is null || p.Value.Length > 4096 || result.ContainsKey(p.Name))
				throw new OperationException(OperationFailure.InvalidInput, "Property/parameter names must be unique and 1–128 characters, with values at most 4096 characters.");
			try
			{
				var c = CultureInfo.InvariantCulture;
				object value = p.Type switch
				{
					"string" => p.Value,
					"boolean" => p.Value switch { "true" => true, "false" => false, _ => throw new FormatException() },
					"int32" => int.Parse(p.Value, NumberStyles.AllowLeadingSign, c),
					"int64" => long.Parse(p.Value, NumberStyles.AllowLeadingSign, c),
					"double" => double.TryParse(p.Value, NumberStyles.Float, c, out var number) && double.IsFinite(number) ? number : throw new FormatException(),
					"datetime" when correlation => Regex.IsMatch(p.Value, @"(Z|[+-]\d{2}:\d{2})$") ? DateTimeOffset.ParseExact(p.Value, "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK", c, DateTimeStyles.None).UtcDateTime : throw new FormatException(),
					"timespan" when correlation => TimeSpan.ParseExact(p.Value, "c", c),
					_ => throw new FormatException()
				};
				result.Add(p.Name, value);
			}
			catch (Exception e) when (e is FormatException or OverflowException) { throw new OperationException(OperationFailure.InvalidInput, "Invalid rule property/parameter type or value. SQL parameters support string, boolean, int32, int64 and finite double; correlation properties also support UTC datetime and timespan."); }
		}
		return result;
	}
	public static void Validate(RuleDefinition definition) => Prepare(definition);
	public static PreparedSubscriptionRule Prepare(RuleDefinition d)
	{
		if (d.SqlExpression is null || d.ActionExpression is null || d.SqlExpression.Length > 1024 || d.ActionExpression.Length > 1024)
			throw new OperationException(OperationFailure.InvalidInput, "SQL filters and actions are limited to 1024 characters each.");
		var parameters = Properties(d.FilterParameters, false);
		var actionParameters = Properties(d.ActionParameters, false);
		if (d.FilterType != "sql" && (d.SqlExpression.Length != 0 || parameters.Count != 0) || d.FilterType != "correlation" && d.Correlation is not null)
			throw new OperationException(OperationFailure.InvalidInput, "Only fields for the selected filter type may be supplied.");
		Dictionary<string, object> correlationProperties = [];
		if (d.FilterType == "sql")
		{
			if (string.IsNullOrWhiteSpace(d.SqlExpression))
				throw new OperationException(OperationFailure.InvalidInput, "Enter a SQL filter expression.");
		}
		else if (d.FilterType == "correlation")
		{
			var c = d.Correlation ?? throw new OperationException(OperationFailure.InvalidInput, "Correlation fields are required.");
			var headers = new[] { c.CorrelationId, c.MessageId, c.Subject, c.ContentType, c.To, c.ReplyTo, c.SessionId, c.ReplyToSessionId };
			if (headers.Any(v => v is not null && (string.IsNullOrWhiteSpace(v) || v.Length > 260)) ||
				new[] { c.CorrelationId, c.MessageId, c.SessionId, c.ReplyToSessionId }.Any(v => v?.Length > 128))
				throw new OperationException(OperationFailure.InvalidInput, "Correlation headers must be nonblank or unset; IDs are limited to 128 characters and other headers to 260.");
			correlationProperties = Properties(c.Properties, true);
			if (headers.All(v => v is null) && correlationProperties.Count == 0)
				throw new OperationException(OperationFailure.InvalidInput, "Specify at least one correlation match. Use a True filter to match all messages.");
		}
		else if (d.FilterType is not ("true" or "false"))
			throw new OperationException(OperationFailure.InvalidInput, "Unsupported filter type.");
		if (d.ActionExpression.Length == 0)
		{
			if (actionParameters.Count != 0)
				throw new OperationException(OperationFailure.InvalidInput, "Action parameters require an action expression.");
		}
		else if (string.IsNullOrWhiteSpace(d.ActionExpression))
			throw new OperationException(OperationFailure.InvalidInput, "An action must contain SQL or be empty to remove it.");
		return new(d, parameters, correlationProperties, actionParameters);
	}
}
