using System.Text.Json;
using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Application.EventGrid.Browsing;
using MsgCommander.Contracts.EventGrid.Administration;
using MsgCommander.Domain.EventGrid;

namespace MsgCommander.Application.EventGrid.Administration;

public static class EventGridAdministrationRules
{
	public static int Validate(this EventGridAdminFilter filter)
	{
		var (Key, OperatorType, OperandJson) = filter;
		if (string.IsNullOrWhiteSpace(Key) || Key.Length > 512 || Key.Any(char.IsControl) || !AdvancedFilterOperators.Supported.Contains(OperatorType) || OperandJson is null || OperandJson.Length > 32768)
			throw Bad();
		if (OperatorType is "IsNotNull" or "IsNullOrUndefined")
		{
			if (OperandJson != "")
				throw Bad();
			return 0;
		}
		try
		{
			using var document = JsonDocument.Parse(OperandJson, new()
			{
				MaxDepth = 4
			});
			var value = document.RootElement;
			static bool Number(JsonElement n) => n.ValueKind == JsonValueKind.Number && n.TryGetDouble(out var d) && double.IsFinite(d);
			var scalar = OperatorType == "BoolEquals" || OperatorType.Contains("GreaterThan") || OperatorType.Contains("LessThan");
			bool valid;
			if (OperatorType == "BoolEquals")
				valid = value.ValueKind is JsonValueKind.True or JsonValueKind.False;
			else if (scalar)
				valid = Number(value);
			else if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() is < 1 or > 25)
				valid = false;
			else if (OperatorType.EndsWith("Range"))
				valid = value.EnumerateArray().All(r => r.ValueKind == JsonValueKind.Array && r.GetArrayLength() == 2 && r.EnumerateArray().All(Number) && r[0].GetDouble() <= r[1].GetDouble());
			else if (OperatorType.StartsWith("Number"))
				valid = value.EnumerateArray().All(Number);
			else
				valid = value.EnumerateArray().All(n => n.ValueKind == JsonValueKind.String && n.GetString()!.Length is > 0 and <= 512);
			if (!valid)
				throw Bad();
			return scalar ? 1 : value.EnumerateArray().Sum(v => v.ValueKind == JsonValueKind.Array ? v.GetArrayLength() : 1);
		}
		catch (JsonException) { throw Bad(); }
	}
	private static OperationException Bad() => new(OperationFailure.InvalidInput, "Invalid advanced filter. Check the operator, key and typed JSON values (maximum 25 values or ranges per filter).");

	public static void ValidateFilters(IReadOnlyList<EventGridAdminFilter>? filters)
	{
		var count = 0;
		foreach (var f in filters ?? [])
		{
			count += f.Validate();
		}
		if (count > 25)
			throw new OperationException(OperationFailure.InvalidInput, "Advanced filters support at most 25 values across the subscription (range endpoints count individually).");
	}
	public static TimeSpan? Validate(this EventGridSubscriptionSettings value)
	{
		var (DeliveryMode, ReceiveLockDurationInSeconds, MaxDeliveryCount, EventTimeToLive, ExpirationTimeUtc, IncludedEventTypes, Filters) = value;
		if (DeliveryMode is not ("Queue" or "Push") || (ReceiveLockDurationInSeconds is { } l && (DeliveryMode != "Queue" || l is < 60 or > 300)) || (MaxDeliveryCount is { } m && m is < 1 or > 10) || IncludedEventTypes?.Count > 100 || IncludedEventTypes?.Any(v => string.IsNullOrWhiteSpace(v) || v.Length > 1024 || v.Any(char.IsControl)) == true || Filters?.Count > 25)
			throw new OperationException(OperationFailure.InvalidInput, "Invalid Event Grid delivery settings or event types.");
		if (ExpirationTimeUtc is not null && (ExpirationTimeUtc.Length > 64 || !DateTimeOffset.TryParse(ExpirationTimeUtc, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var expiration) || !ExpirationTimeUtc.EndsWith('Z') || expiration <= DateTimeOffset.UtcNow))
			throw new OperationException(OperationFailure.InvalidInput, "Subscription expiration must be a future UTC timestamp ending in Z, or empty for no expiration.");
		ValidateFilters(Filters);

		try
		{
			return EventGridRetention.TimeToLive(EventTimeToLive);
		}
		catch (MsgCommander.Domain.Common.DomainRuleException error) { throw new OperationException(OperationFailure.InvalidInput, error.Message); }
	}

	public static void Validate(this EventGridDestination value)
	{
		var (EndpointType, EndpointUrl, ResourceId, QueueName) = value;
		if (EndpointType == "WebHook")
		{
			if (EndpointUrl is null || EndpointUrl.Length > 8192 || EndpointUrl.Any(char.IsWhiteSpace) || EndpointUrl.Any(char.IsControl) || !Uri.TryCreate(EndpointUrl, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.UserInfo != "" || uri.Fragment != "" || ResourceId is not null || QueueName is not null)
				throw new OperationException(OperationFailure.InvalidInput, "Use an HTTPS webhook URL without user information or fragment.");
		}
		else
		{
			var patterns = new Dictionary<string, string> { { "EventHub", @"Microsoft.EventHub/namespaces/[^/]+/eventhubs/[^/]+" }, { "ServiceBusQueue", @"Microsoft.ServiceBus/namespaces/[^/]+/queues/[^/]+" }, { "ServiceBusTopic", @"Microsoft.ServiceBus/namespaces/[^/]+/topics/[^/]+" }, { "NamespaceTopic", @"Microsoft.EventGrid/namespaces/[^/]+/topics/[^/]+" }, { "AzureFunction", @"Microsoft.Web/sites/[^/]+/functions/[^/]+" }, { "HybridConnection", @"Microsoft.Relay/namespaces/[^/]+/hybridConnections/[^/]+" }, { "StorageQueue", @"Microsoft.Storage/storageAccounts/[^/]+" } };
			if (!patterns.TryGetValue(EndpointType, out var suffix) || ResourceId is null || ResourceId.Length > 1024 || !Regex.IsMatch(ResourceId, @"^/subscriptions/[0-9a-f-]{36}/resourceGroups/[^/]+/providers/" + suffix + "$", RegexOptions.IgnoreCase) || ResourceId.Split('/').Any(s => s is "." or ".." || s.Contains('%') || s.Contains('?') || s.Contains('#') || s.Any(char.IsControl)) || !Guid.TryParse(ResourceId.Split('/')[2], out _) || EndpointUrl is not null)
				throw new OperationException(OperationFailure.InvalidInput, "Use an ARM resource ID matching the selected Push destination type.");
			if (EndpointType == "StorageQueue")
			{
				if (QueueName is null || !Regex.IsMatch(QueueName, @"^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$") || QueueName.Contains("--"))
					throw new OperationException(OperationFailure.InvalidInput, "Use a valid Azure Storage queue name.");
			}
			else if (QueueName is not null)
				throw new OperationException(OperationFailure.InvalidInput, "Queue name applies only to Storage Queue destinations.");
		}
	}

	public static void Validate(this EventGridAdminChange value) => EventGridCommands.Prepare(value);
}
