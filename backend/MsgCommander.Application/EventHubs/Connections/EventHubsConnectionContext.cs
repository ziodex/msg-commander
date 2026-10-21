using MsgCommander.Application.Common;
using MsgCommander.Application.Connections;
using MsgCommander.Application.EventHubs.Administration;
using MsgCommander.Application.EventHubs.Browsing;
using MsgCommander.Application.EventHubs.Configuration;
using MsgCommander.Application.EventHubs.Gateways;
using MsgCommander.Application.EventHubs.Messaging;
using MsgCommander.Application.ResourceConfiguration;
using MsgCommander.Contracts.EventHubs.Browsing;

namespace MsgCommander.Application.EventHubs.Connections;

/// <summary>Feature state belongs to one connection generation. The owner serializes all calls.</summary>
public sealed class EventHubsConnectionContext
{
	public IEventHubsGateway Gateway
	{
		get;
	}
	public EventHubsConnection Connection
	{
		get;
	}
	public DeviceCodePrompts Prompts
	{
		get;
	}
	public EventSnapshotStore Snapshots { get; } = new();
	public EventHubReadService Read
	{
		get;
	}
	public EventHubSendService Send
	{
		get;
	}
	public EventHubListenService Listen
	{
		get;
	}
	public EventHubsBrowsingService Browse
	{
		get;
	}
	public EventHubsAdministrationService Administration
	{
		get;
	}
	private readonly IConfigurationFailureClassifier configurationFailures;
	private MessagingConfigurationService? configuration;
	public MessagingConfigurationService Configuration => Connection.Service != "iot-hub"
		? configuration ??= new(new EventHubsConfigurationGateway(Gateway, Connection), configurationFailures)
		: throw new OperationException(OperationFailure.InvalidInput, "IoT Hub built-in endpoints do not support resource configuration migration.");

	public EventHubsConnectionContext(IEventHubsGateway gateway, EventHubsConnection connection, EventHubResourceCleanup cleanup,
		IEventHubsFailureClassifier failures, IConfigurationFailureClassifier configurationFailures, DeviceCodePrompts prompts)
	{
		Gateway = gateway;
		Connection = connection;
		Prompts = prompts;
		this.configurationFailures = configurationFailures;
		Read = new(gateway, connection, Snapshots, cleanup);
		Send = new(gateway, cleanup, failures);
		Listen = new(gateway, connection, Snapshots, cleanup);
		Browse = new(gateway, connection);
		Administration = new(gateway, failures);
	}
	public void Require(EventHubOperation operation, string? hubName)
	{
		if (Connection.Service == "iot-hub")
		{
			if (operation is EventHubOperation.Browse or EventHubOperation.Send or EventHubOperation.Administration)
				throw new OperationException(OperationFailure.InvalidInput, "IoT Hub built-in endpoints support listening and inspection only; manage IoT resources and consumer groups in Azure.");
			if (hubName is not null && hubName != Connection.InitialHub?.Name)
				throw new OperationException(OperationFailure.InvalidInput, "The requested hub must match the IoT Hub built-in EntityPath.");
		}
		if (Connection.Access == "send" && operation is EventHubOperation.Read or EventHubOperation.Listen)
			throw new OperationException(OperationFailure.InvalidInput, operation == EventHubOperation.Listen
				? "Reconnect in read mode to listen. No receiver was opened."
				: "Reconnect in read mode to receive events. Send-only mode does not open a receiver.");
	}
	public void Close()
	{
		Prompts.Close();
		configuration?.Clear();
		configuration = null;
		Snapshots.Clear();
		Read.Clear();
		Send.Clear();
		Listen.Clear();
		Browse.Clear();
		Administration.Clear();
	}
}
