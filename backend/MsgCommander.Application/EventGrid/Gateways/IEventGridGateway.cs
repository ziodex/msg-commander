using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.EventGrid.Browsing;
using MsgCommander.Contracts.EventGrid.Administration;
using MsgCommander.Application.EventGrid.Pulling;
using MsgCommander.Application.EventGrid.Administration;

namespace MsgCommander.Application.EventGrid.Gateways;

public interface IEventGridGatewayFactory
{
	Task<IEventGridGateway> ConnectAsync(ConnectionProfile profile, EventGridManagement management, Func<DeviceCodeEvent, Task> deviceCode, CancellationToken cancellation);
}
public interface IEventGridGateway : IAsyncDisposable
{
	string Location
	{
		get;
	}
	Task<EventGridReceiveBatch> ReceiveAsync(EventGridTarget target, int maxEvents, int maxWait, Action dispatch, CancellationToken cancellation);
	Task<EventGridSettlementBatch> SettleAsync(EventGridTarget target, string action, int delay, IReadOnlyList<EventGridLockToken> tokens, Action dispatch, CancellationToken cancellation);
	Task PublishAsync(string topic, string mode, byte[] body, Action dispatch, CancellationToken cancellation);
	Task<EventGridAdminDetails> AdminGetAsync(EventGridTarget target, CancellationToken cancellation);
	Task<string> ChangeAsync(EventGridCommand change, Action dispatch, CancellationToken cancellation);
	Task<EventGridPage> ListAsync(EventGridTarget parent, string? continuation, CancellationToken cancellation);
	Task<EventGridDetails> GetAsync(EventGridTarget target, CancellationToken cancellation);
}
