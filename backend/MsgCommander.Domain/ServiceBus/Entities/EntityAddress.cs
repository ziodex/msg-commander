namespace MsgCommander.Domain.ServiceBus.Entities;

/// <summary>A broker entity address, independent of SDK and wire contracts.</summary>
public sealed record EntityAddress
{
	public string Kind
	{
		get;
	}
	public string Name
	{
		get;
	}
	public string? TopicName
	{
		get;
	}

	private EntityAddress(string kind, string name, string? topicName)
	{
		Kind = kind;
		Name = name;
		TopicName = topicName;
	}

	public bool SupportsReceiving => Kind is "queue" or "subscription";

	public static EntityAddress? TryCreate(string? kind, string? name, string? topicName = null)
	{
		if (kind is not ("queue" or "topic" or "subscription") ||
			string.IsNullOrWhiteSpace(name) || name.Length > 260 ||
			(kind == "subscription" && (string.IsNullOrWhiteSpace(topicName) || topicName.Length > 260)))
			return null;
		return new(kind, name, topicName);
	}
}
