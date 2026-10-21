using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.EventHubs.Messaging;

namespace MsgCommander.Application.EventHubs.Connections;

public sealed record EventHubConnect(ConnectionProfile Profile, string HubName, string Access, EventHubsManagementContext? Management);
public enum EventHubOperation
{
	Shared, Browse, Read, Listen, Send, Administration, Configuration
}
