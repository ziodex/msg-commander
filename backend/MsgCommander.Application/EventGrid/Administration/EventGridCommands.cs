using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Application.EventGrid.Browsing;
using MsgCommander.Contracts.EventGrid.Administration;
using MsgCommander.Contracts.EventGrid.Browsing;

namespace MsgCommander.Application.EventGrid.Administration;

// The transport DTO stays stable; each application command carries its required settings.
public abstract record EventGridCommand(string Id, EventGridTarget Target, string? ExpectedRevision)
{
	public abstract string Action
	{
		get;
	}
}
public sealed record CreateEventGridTopic(string Id, EventGridTarget Target, int RetentionDays)
	: EventGridCommand(Id, Target, null)
{
	public override string Action => "create";
}
public sealed record UpdateEventGridTopic(string Id, EventGridTarget Target, string Revision, int RetentionDays)
	: EventGridCommand(Id, Target, Revision)
{
	public override string Action => "update";
}
public sealed record DeleteEventGridResource(string Id, EventGridTarget Target, string Revision)
	: EventGridCommand(Id, Target, Revision)
{
	public override string Action => "delete";
}
public abstract record EventGridSubscriptionCommand(string Id, EventGridTarget Target, string? ExpectedRevision,
	EventGridSubscriptionSettings Settings, EventGridDestination? Destination, EventGridDelivery? Delivery)
	: EventGridCommand(Id, Target, ExpectedRevision);
public sealed record CreateEventGridSubscription(string Id, EventGridTarget Target,
	EventGridSubscriptionSettings Settings, EventGridDestination? Destination, EventGridDelivery? Delivery)
	: EventGridSubscriptionCommand(Id, Target, null, Settings, Destination, Delivery)
{
	public override string Action => "create";
}
public sealed record UpdateEventGridSubscription(string Id, EventGridTarget Target, string Revision,
	EventGridSubscriptionSettings Settings, EventGridDestination? Destination, EventGridDelivery? Delivery)
	: EventGridSubscriptionCommand(Id, Target, Revision, Settings, Destination, Delivery)
{
	public override string Action => "update";
}

public static class EventGridCommands
{
	public static EventGridCommand Prepare(EventGridAdminChange request)
	{
		request.Target.Validate();
		if (request.Target.Kind == "namespace" || !Guid.TryParse(request.Id, out _) ||
			!Guid.TryParse(request.ConnectionId, out _) || !request.Acknowledged ||
			request.Action is not ("create" or "update" or "delete") ||
			(request.Action == "create") != (request.ExpectedRevision is null) ||
			request.ExpectedRevision is { } revision && !Regex.IsMatch(revision, @"^[A-F0-9]{64}$"))
			throw Invalid("Review the target and current settings and acknowledge the Event Grid change.");

		if (request.Action == "delete")
		{
			if (request.Confirmation != (request.Target.SubscriptionName ?? request.Target.TopicName) ||
				request.RetentionDays is not null || request.Settings is not null ||
				request.Destination is not null || request.Delivery is not null)
				throw Invalid("Type the exact topic or subscription name to delete it.");
			return new DeleteEventGridResource(request.Id, request.Target, request.ExpectedRevision!);
		}
		if (request.Confirmation is not null)
			throw Invalid("Specify supported settings for this Event Grid target.");
		if (request.Target.Kind == "topic")
			return Topic(request);
		return Subscription(request);
	}

	private static EventGridCommand Topic(EventGridAdminChange request)
	{
		if (request.RetentionDays is not (>= 1 and <= 7) || request.Settings is not null ||
			request.Destination is not null || request.Delivery is not null)
			throw Invalid("Specify supported settings for this Event Grid target.");
		return request.Action == "create"
			? new CreateEventGridTopic(request.Id, request.Target, request.RetentionDays.Value)
			: new UpdateEventGridTopic(request.Id, request.Target, request.ExpectedRevision!, request.RetentionDays.Value);
	}

	private static EventGridSubscriptionCommand Subscription(EventGridAdminChange request)
	{
		if (request.Settings is not { } settings || request.RetentionDays is not null)
			throw Invalid("Specify supported settings for this Event Grid target.");
		settings.Validate();
		if (request.Action == "update" && request.Destination is not null &&
			(request.Delivery?.Identity is null || request.Delivery.Headers is null))
			throw Invalid("Replacing a destination requires an explicit identity and fresh headers.");
		if (request.Destination is not null && settings.DeliveryMode != "Push" ||
			request.Action == "create" && (settings.Filters is null ||
				settings.DeliveryMode == "Push" && request.Destination is null))
			throw Invalid("Specify filters and the Push destination when applicable.");
		request.Destination?.Validate();
		request.Delivery?.Validate(settings.DeliveryMode, request.Destination, request.Action);
		return request.Action == "create"
			? new CreateEventGridSubscription(request.Id, request.Target, settings, request.Destination, request.Delivery)
			: new UpdateEventGridSubscription(request.Id, request.Target, request.ExpectedRevision!, settings, request.Destination, request.Delivery);
	}

	private static OperationException Invalid(string message) => new(OperationFailure.InvalidInput, message);
}
