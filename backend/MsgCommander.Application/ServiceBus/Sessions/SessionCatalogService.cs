using System.Globalization;
using System.Text.Json;
using MsgCommander.Application.Common;
using MsgCommander.Application.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Messages;
using MsgCommander.Contracts.ServiceBus.Sessions;
using MsgCommander.Domain.ServiceBus.Messages;
using static MsgCommander.Application.Common.DisplayValues;
using static MsgCommander.Application.ServiceBus.Messages.MessageProjection;
using MsgCommander.Application.ServiceBus.Messages;

namespace MsgCommander.Application.ServiceBus.Sessions;

public sealed class SessionCatalogService(IServiceBusMessagingGateway gateway) : IAsyncDisposable
{
	private SessionScan? sessionScan;
	private sealed class SessionScan(EntityTarget target, CancellationTokenSource lifetime, IAsyncEnumerator<string> iterator)
	{
		public EntityTarget Target { get; } = target;
		public CancellationTokenSource Lifetime { get; } = lifetime;
		public IAsyncEnumerator<string> Iterator { get; } = iterator;
		public string Token { get; set; } = Guid.NewGuid().ToString();
		public DateTimeOffset LastUsed { get; set; } = DateTimeOffset.UtcNow;
	}
	public async ValueTask DisposeAsync()
	{
		var scan = sessionScan;
		sessionScan = null;
		if (scan is null)
			return;
		scan.Lifetime.Cancel();
		try
		{
			await scan.Iterator.DisposeAsync();
		}
		finally { scan.Lifetime.Dispose(); }
	}
	private async Task CheckSessionTarget(EntityTarget target, CancellationToken cancellation)
	{
		target.Validate(peek: true);
		if ((await gateway!.GetEntityAsync(target, cancellation)).Entity.RequiresSession != true)
			throw new OperationException(OperationFailure.InvalidInput, "Choose a session-enabled queue or subscription. Sessions apply to its main queue only.");
	}
	public async Task<SessionPage> ListAsync(EntityTarget target, string? token, CancellationToken cancellation)
	{
		target.Validate(peek: true);
		if (token is null)
		{
			await CheckSessionTarget(target, cancellation);
			await DisposeAsync();
			var lifetime = new CancellationTokenSource();
			sessionScan = new(target, lifetime, gateway!.ListSessionsAsync(target, lifetime.Token).GetAsyncEnumerator());
		}
		else if (sessionScan is null || sessionScan.Target != target || sessionScan.Token != token || sessionScan.LastUsed.AddMinutes(5) < DateTimeOffset.UtcNow)
			throw new OperationException(OperationFailure.SessionCursorInvalid, "Session listing cursor expired. Refresh sessions to start again.");
		var scan = sessionScan!;
		using var registration = cancellation.Register(() => { try { scan.Lifetime.Cancel(); } catch (ObjectDisposedException) { } });
		try
		{
			List<string> items = [];
			while (items.Count < 100)
			{
				cancellation.ThrowIfCancellationRequested();
				if (!await scan.Iterator.MoveNextAsync())
				{
					await DisposeAsync();
					return new(items, null);
				}
				var id = scan.Iterator.Current;
				if (string.IsNullOrWhiteSpace(id) || id.Length > 128)
					throw new OperationException(OperationFailure.SessionCursorInvalid, "The broker returned an unsupported session ID. No session was accepted.");
				items.Add(id);
			}
			cancellation.ThrowIfCancellationRequested();
			scan.Token = Guid.NewGuid().ToString();
			scan.LastUsed = DateTimeOffset.UtcNow;
			return new(items, scan.Token);
		}
		catch { await DisposeAsync(); throw; } // A cancelled iterator cannot safely resume its consumed prefix.
	}

	public async Task CloseAsync(string? token)
	{
		if (sessionScan?.Token == token)
			await DisposeAsync();
	}
}
