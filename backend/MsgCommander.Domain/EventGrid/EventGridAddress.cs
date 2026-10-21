using System.Text.RegularExpressions;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.EventGrid;

public sealed record EventGridAddress
{
	public string Kind
	{
		get;
	}
	public string? TopicName
	{
		get;
	}
	public string? SubscriptionName
	{
		get;
	}
	private EventGridAddress(string kind, string? topicName, string? subscriptionName)
	{
		Kind = kind;
		TopicName = topicName;
		SubscriptionName = subscriptionName;
	}
	public static bool IsName(string? value) => value is not null && Regex.IsMatch(value, @"^[A-Za-z0-9-]{3,50}$");
	public static EventGridAddress Create(string kind, string? topicName, string? subscriptionName)
	{
		if (kind is not ("namespace" or "topic" or "subscription") || (kind != "namespace") != (topicName is not null) ||
			(kind == "subscription") != (subscriptionName is not null) || topicName is not null && !IsName(topicName) || subscriptionName is not null && !IsName(subscriptionName))
			throw new DomainRuleException("Choose an Event Grid namespace, topic or subscription with its correct parent.");
		return new(kind, topicName, subscriptionName);
	}
	public string Suffix => (TopicName is null ? "" : "/topics/" + Uri.EscapeDataString(TopicName)) +
		(SubscriptionName is null ? "" : "/eventSubscriptions/" + Uri.EscapeDataString(SubscriptionName));
}
