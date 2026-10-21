using System.Runtime.CompilerServices;
using MsgCommander.Application.Common;

namespace MsgCommander.Application.EventGrid.Pulling;

/// <summary>A broker lease scoped to its issuing adapter. It has no serializable token property.</summary>
public sealed class EventGridLockToken : IEquatable<EventGridLockToken>
{
	private readonly object issuer;
	private readonly string token;
	public EventGridLockToken(object issuer, string token)
	{
		ArgumentNullException.ThrowIfNull(issuer);
		if (string.IsNullOrEmpty(token) || token.Length > 16384)
			throw new ArgumentException("Invalid broker lease.", nameof(token));
		this.issuer = issuer;
		this.token = token;
	}
	public string ForTransport(object owner) => ReferenceEquals(issuer, owner) ? token
		: throw new OperationException(OperationFailure.InvalidInput, "Event lease belongs to another connection.");
	public bool Equals(EventGridLockToken? other) => other is not null && ReferenceEquals(issuer, other.issuer) && StringComparer.Ordinal.Equals(token, other.token);
	public override bool Equals(object? other) => other is EventGridLockToken value && Equals(value);
	public override int GetHashCode() => HashCode.Combine(RuntimeHelpers.GetHashCode(issuer), StringComparer.Ordinal.GetHashCode(token));
	public override string ToString() => "[Event Grid lease]";
}
public sealed record EventGridDeliveryEnvelope(EventGridLockToken Token, int DeliveryCount, string EventJson);
public sealed record EventGridReceiveBatch(IReadOnlyList<EventGridDeliveryEnvelope> Events);
public enum EventGridSettlementFailureCode
{
	BadToken, TokenLost, LockLost, LockTokenExpired, Unauthorized, TooManyRequests, SettlementFailed
}
public sealed record EventGridTokenFailure(EventGridLockToken Token, EventGridSettlementFailureCode Code);
public sealed record EventGridSettlementBatch(IReadOnlyList<EventGridLockToken> Succeeded, IReadOnlyList<EventGridTokenFailure> Failed);
