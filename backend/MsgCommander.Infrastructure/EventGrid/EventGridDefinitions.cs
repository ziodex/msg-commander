using System.Text.Json.Nodes;
namespace MsgCommander.Infrastructure.EventGrid;

public static class EventGridDefinitions
{
	public static JsonObject Definition(this EventGridAdminFilter value)
	{
		value.Validate();
		var json = new JsonObject { ["key"] = value.Key, ["operatorType"] = value.OperatorType };
		if (value.OperatorType is not ("IsNotNull" or "IsNullOrUndefined"))
			json[value.OperatorType == "BoolEquals" || value.OperatorType.Contains("GreaterThan") || value.OperatorType.Contains("LessThan") ? "value" : "values"] = JsonNode.Parse(value.OperandJson);
		return json;
	}
	public static JsonObject Definition(this EventGridDestination value)
	{
		value.Validate();
		var p = new JsonObject();
		if (value.EndpointType == "WebHook")
			p["endpointUrl"] = value.EndpointUrl;
		else
		{
			p["resourceId"] = value.ResourceId;
			if (value.EndpointType == "StorageQueue")
				p["queueName"] = value.QueueName;
		}
		return new()
		{
			["endpointType"] = value.EndpointType,
			["properties"] = p
		};
	}
	public static JsonObject Definition(this EventGridIdentity value)
	{
		value.Validate(false);
		var result = new JsonObject { ["type"] = value.Type };
		if (value.Type == "UserAssigned")
			result["userAssignedIdentity"] = value.UserAssignedIdentity;
		return result;
	}
	public static JsonObject Definition(this EventGridHeader value)
	{
		value.Validate();
		var p = new JsonObject();
		if (value.Type == "Static")
		{
			p["value"] = value.Value;
			p["isSecret"] = value.IsSecret;
		}
		else
			p["sourceField"] = value.SourceField;
		return new()
		{
			["name"] = value.Name,
			["type"] = value.Type,
			["properties"] = p
		};
	}
	public static JsonObject? Definition(this EventGridDeadLetterChange value)
	{
		value.Validate();
		return value.Action == "clear" ? null : new()
		{
			["identity"] = value.Identity!.Definition(),
			["deadLetterDestination"] = new JsonObject { ["endpointType"] = "StorageBlob", ["properties"] = new JsonObject { ["resourceId"] = value.ResourceId, ["blobContainerName"] = value.ContainerName } }
		};
	}
}
