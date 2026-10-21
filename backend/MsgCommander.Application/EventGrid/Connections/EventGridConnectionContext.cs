using MsgCommander.Application.Connections;
using MsgCommander.Application.EventGrid.Gateways;
using MsgCommander.Application.EventGrid.Administration;
using MsgCommander.Application.EventGrid.Browsing;
using MsgCommander.Application.EventGrid.Pulling;
using MsgCommander.Application.EventGrid.Publishing;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.EventGrid.Browsing;

namespace MsgCommander.Application.EventGrid.Connections;

public sealed record EventGridConnect(ConnectionProfile Profile, EventGridManagement Management);

public sealed class EventGridConnectionContext
{
	public IEventGridGateway Gateway
	{
		get;
	}
	public EventGridConnection Connection
	{
		get;
	}
	public DeviceCodePrompts Prompts
	{
		get;
	}
	public EventGridBrowsingService Browsing
	{
		get;
	}
	public EventGridAdministrationService Administration
	{
		get;
	}
	public EventGridPublishingService Publishing
	{
		get;
	}
	public EventGridPullService Pull
	{
		get;
	}
	public EventGridConnectionContext(IEventGridGateway gateway, EventGridConnection connection, DeviceCodePrompts prompts,
		IEventGridFailureClassifier failures, TimeProvider? timeProvider)
	{
		Gateway = gateway;
		Connection = connection;
		Prompts = prompts;
		Browsing = new(gateway);
		Administration = new(gateway, failures);
		Publishing = new(gateway, failures);
		Pull = new(gateway, failures, timeProvider);
	}
	public void Close()
	{
		Prompts.Close();
		Browsing.Clear();
		Administration.Clear();
		Publishing.Clear();
		Pull.Clear();
		// Dropping local snapshots does not settle broker locks. No writes run during disconnect.
	}
}
