using MsgCommander.Application.EventHubs.Administration;
using MsgCommander.Contracts.EventHubs.Browsing;

namespace MsgCommander.Application.EventHubs.Browsing;

public interface IEventHubsCatalog
{
	IEventHubsAdministration? Administration
	{
		get;
	}
	Task<EventHubsPage> ListAsync(string kind, string hubName, string? continuation, CancellationToken cancellation);
}
