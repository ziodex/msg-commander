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
using System.Security.Cryptography;

namespace MsgCommander.Application.ServiceBus.Messages;

public sealed partial class InteractiveReceiverService
{
	private const int SessionStateLimit = 262144;
	private string? sessionLeaseId;
	private bool sessionLockLost, sessionLockUncertain, sessionStateUncertain;
	private async Task CheckSessionTarget(EntityTarget target, CancellationToken cancellation)
	{
		target.Validate(peek: true);
		if ((await gateway!.GetEntityAsync(target, cancellation)).Entity.RequiresSession != true)
			throw new OperationException(OperationFailure.InvalidInput, "Choose a session-enabled queue or subscription. Sessions apply to its main queue only.");
	}
	private void TrackSession()
	{
		sessionLeaseId = ownedReceiver?.SessionId is null ? null : receiverOwner.OwnershipId;
		sessionLockLost = sessionLockUncertain = sessionStateUncertain = false;
	}
	private SessionLease? CurrentSession()
	{
		if (sessionLeaseId is null || receivedTarget is null || ownedReceiver?.SessionId is not string id)
			return null;
		var until = ownedReceiver.SessionLockedUntil ?? DateTimeOffset.MinValue;
		if (until <= DateTimeOffset.UtcNow)
			sessionLockLost = true;
		if (sessionLockLost)
			foreach (var item in deliveries.Values.Where(item => item.State == "active"))
				item.State = "lock-lost";
		return new(sessionLeaseId, receivedTarget, id, Timestamp(until), sessionLockLost ? "lock-lost" : sessionLockUncertain ? "unknown" : "active", sessionStateUncertain);
	}
	private SessionLease RequireSession(string? leaseId, bool allowLost = false)
	{
		var lease = CurrentSession();
		if (lease is null || lease.LeaseId != leaseId)
			throw new OperationException(OperationFailure.SessionLeaseExpired, "This session lease expired. Refresh held messages and accept the session again.");
		if (!allowLost && lease.Status != "active")
			throw new OperationException(OperationFailure.SessionLockUnavailable, "The session lock is lost or uncertain. Release this receiver and explicitly accept the session again.");
		return lease;
	}
	public async Task<Deliveries> AcceptSessionAsync(AcceptSession request, CancellationToken cancellation)
	{
		var target = request.Target;
		var id = request.SessionId;
		if (string.IsNullOrWhiteSpace(id) || id.Length > 128)
			throw new OperationException(OperationFailure.InvalidInput, "Enter a session ID of 1–128 characters.");
		await CheckSessionTarget(target, cancellation);
		if (ownedReceiver is not null)
		{
			var current = CurrentSession();
			if (current?.Target == target && current.SessionId == id && current.Status == "active")
				return CurrentDeliveries();
			throw new OperationException(OperationFailure.OperationBlocked, "Close the current receiver before accepting another session. Settle any held messages first.");
		}
		await receiverOwner.OpenAsync(new(target, "active", id),
			token => gateway!.OpenReceiverAsync(target, "active", id, token), cancellation);
		TrackSession();
		if (ownedReceiver!.SessionId != id)
		{
			await DisposeAsync();
			throw new OperationException(OperationFailure.SessionLeaseExpired, "The receiver did not accept the requested session.");
		}
		return CurrentDeliveries();
	}
	private static string StateRevision(MessageBody? state)
	{
		using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
		hash.AppendData([state is null ? (byte)0 : (byte)1]);
		if (state is not null)
			hash.AppendData(state.ToMemory().Span);
		return Convert.ToHexString(hash.GetHashAndReset());
	}
	private async Task<MessageBody?> ReadState(CancellationToken cancellation)
	{
		try
		{
			return await ownedReceiver!.GetSessionStateAsync(cancellation);
		}
		catch (Exception error) when (failures.Classify(error).Kind == MessageFailureKind.SessionLockLost)
		{
			sessionLockLost = true;
			CurrentSession();
			throw;
		}
	}
	public async Task<SessionState> GetSessionStateAsync(string leaseId, CancellationToken cancellation)
	{
		var lease = RequireSession(leaseId);
		var state = await ReadState(cancellation);
		cancellation.ThrowIfCancellationRequested();
		RequireSession(lease.LeaseId);
		sessionStateUncertain = false; // Successful explicit broker read resolves an uncertain state write.
		var size = state?.ToMemory().Length ?? 0;
		if (size > SessionStateLimit)
			return new(lease.LeaseId, true, size, null, null, false, "State exceeds the 256 KiB local editor limit. It was not truncated or changed.");
		return new(lease.LeaseId, state is not null, size, state is null ? null : Convert.ToBase64String(state.ToMemory().Span), StateRevision(state), true, null);
	}
	public async Task ChangeSessionStateAsync(ChangeSessionState request, Action dispatching, CancellationToken cancellation)
	{
		var lease = RequireSession(request.LeaseId);
		if (sessionStateUncertain)
			throw new OperationException(OperationFailure.SessionLockUnavailable, "The previous state write has an unknown outcome. Read state from the broker before editing again.");
		var encoded = request.BodyBase64;
		MessageBody? state = null;
		if (encoded is not null)
		{
			var text = encoded;
			if (text.Length > 349528)
				throw new OperationException(OperationFailure.InvalidInput, "Session state exceeds the 256 KiB editor limit.");
			byte[] bytes;
			try
			{
				bytes = Convert.FromBase64String(text);
			}
			catch (FormatException) { throw new OperationException(OperationFailure.InvalidInput, "State must be canonical base64."); }
			if (bytes.Length > SessionStateLimit || Convert.ToBase64String(bytes) != text)
				throw new OperationException(OperationFailure.InvalidInput, "State must be canonical base64 and at most 256 KiB.");
			state = MessageBody.FromBytes(bytes);
		}
		else if (request.Confirmation != lease.SessionId)
			throw new OperationException(OperationFailure.InvalidInput, "Type the exact session ID to confirm clearing its state.");
		var current = await ReadState(cancellation);
		if ((current?.ToMemory().Length ?? 0) > SessionStateLimit || request.ExpectedRevision != StateRevision(current))
			throw new OperationException(OperationFailure.SessionStateConflict, "Session state changed or exceeds editor limits. Read it again before editing.");
		cancellation.ThrowIfCancellationRequested();
		RequireSession(lease.LeaseId);
		dispatching();
		sessionStateUncertain = true;
		await ownedReceiver!.SetSessionStateAsync(state, cancellation);
		sessionStateUncertain = false; // Acknowledgement wins cancellation races.
	}
	public async Task ReleaseSessionAsync(string? leaseId)
	{
		RequireSession(leaseId, allowLost: true);
		await DisposeAsync();
	}
	public async Task RenewSessionAsync(string? leaseId, Action dispatching, CancellationToken cancellation)
	{
		RequireSession(leaseId);
		cancellation.ThrowIfCancellationRequested();
		dispatching();
		await ownedReceiver!.RenewSessionLockAsync(cancellation);
	}
}
