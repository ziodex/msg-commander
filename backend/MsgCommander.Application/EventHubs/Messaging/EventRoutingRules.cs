using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.EventHubs.Gateways;
using MsgCommander.Application.EventHubs.Messaging;
using MsgCommander.Application.EventHubs.Connections;
using MsgCommander.Application.EventHubs.Browsing;
using MsgCommander.Application.EventHubs.Administration;
using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.EventHubs.Browsing;
using MsgCommander.Contracts.EventHubs.Messaging;
using MsgCommander.Contracts.EventHubs.Administration;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Application.EventHubs.Messaging;

public static class EventRoutingRules
{
	public static EventRouting Validate(EventRouting routing)
	{
		if (routing.Kind == "automatic" && routing.Value is null)
			return routing;
		if (routing.Kind == "partition" && routing.Value is not null)
		{
			EventHubsValidation.Partition(routing.Value);
			return routing;
		}
		if (routing.Kind == "key" && routing.Value is { Length: > 0 and <= 128 })
			return routing;
		throw new OperationException(OperationFailure.InvalidInput, "Choose automatic routing, one partition or one partition key.");
	}
}
