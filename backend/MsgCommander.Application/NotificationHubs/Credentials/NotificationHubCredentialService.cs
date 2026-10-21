using System.Security.Cryptography;
using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Application.NotificationHubs.Gateways;
using MsgCommander.Application.NotificationHubs.Management;
using MsgCommander.Contracts.NotificationHubs.Credentials;
using MsgCommander.Contracts.NotificationHubs.Management;
using static MsgCommander.Application.Common.DisplayValues;

namespace MsgCommander.Application.NotificationHubs.Credentials;

public sealed class NotificationHubCredentialService(INotificationHubGateway gateway, IProviderCredentialCodec codec,
	INotificationHubFailureClassifier failures, NotificationHubReceiptStore receipts, TimeProvider? timeProvider = null)
{
	private DateTimeOffset Now => (timeProvider ?? TimeProvider.System).GetUtcNow();
	private sealed record CredentialArtifact(NotificationHubTarget Target, string Provider, ProviderCredentialMaterial Material, DateTimeOffset Expires);
	private readonly Dictionary<string, CredentialArtifact> artifacts = [];
	public void Clear() => artifacts.Clear();
	public NotificationHubCredentialArtifact Import(NotificationHubCredentialImport request, CancellationToken cancellation)
	{
		NotificationHubCredentialRules.Hub(request.Target);
		NotificationHubCredentialRules.Provider(request.Provider);
		foreach (var stale in artifacts.Where(pair => pair.Value.Expires <= Now).Select(pair => pair.Key).ToArray())
			artifacts.Remove(stale);
		if (artifacts.Count >= 20)
			throw new OperationException(OperationFailure.OperationBlocked, "Credential import limit reached. Close unused provider editors or reconnect.");
		if (request.ContentBase64.Length > 349528)
			throw NotificationHubCredentialRules.InvalidImport();
		byte[] bytes;
		try
		{
			bytes = Convert.FromBase64String(request.ContentBase64);
		}
		catch (FormatException) { throw NotificationHubCredentialRules.InvalidImport(); }
		try
		{
			var imported = codec.Import(request.Provider, bytes, request.Password);
			cancellation.ThrowIfCancellationRequested();
			var expires = Now.AddMinutes(10);
			if (imported.NotAfter is { } end && end < expires)
				expires = end;
			var id = Guid.NewGuid().ToString();
			artifacts.Add(id, new(request.Target, request.Provider, imported.Material, expires));
			return new(id, request.Provider, imported.Summary, Timestamp(expires));
		}
		finally { CryptographicOperations.ZeroMemory(bytes); }
	}
	public void Discard(NotificationHubTarget target, string id)
	{
		NotificationHubCredentialRules.Hub(target);
		if (artifacts.TryGetValue(id, out var artifact) && artifact.Target == target)
			artifacts.Remove(id);
	}
	private ProviderCredentialMaterial? Material(ProviderCredentialReview review, ProviderCredentialDraft draft)
	{
		NotificationHubCredentialRules.Hub(review.Target);
		if (!review.Acknowledged || !Regex.IsMatch(review.ExpectedRevision, "^[A-F0-9]{64}$"))
			throw new OperationException(OperationFailure.InvalidInput, "Review and acknowledge the provider credential replacement.");
		var fields = NotificationHubCredentialRules.Fields(draft);
		if (draft.Remove == true)
			return null;
		ProviderCredentialMaterial? imported = null;
		if (fields.Contains("artifactId"))
		{
			var id = NotificationHubCredentialRules.Value(draft, "artifactId");
			if (!artifacts.TryGetValue(id, out var artifact) || artifact.Target != review.Target || artifact.Provider != draft.Provider || artifact.Expires <= Now)
				throw new OperationException(OperationFailure.ConnectionExpired, "The private credential import expired or belongs to another hub/provider. Import it again.");
			imported = artifact.Material;
		}
		return codec.Build(draft, imported);
	}
	// Deferred draft parsing keeps receipt replay ahead of validation, including failed drafts.
	public async Task<NotificationHubOutcome> ChangeAsync(ProviderCredentialReview review, string stamp,
		Func<ProviderCredentialDraft> readDraft, CancellationToken cancellation)
	{
		if (receipts.Check(review.Id, stamp) is { } prior)
			return prior;
		var dispatched = false;
		var status = "confirmed";
		var summary = "Azure acknowledged the provider credential update. This does not prove provider authentication or device delivery; use a test notification to verify.";
		try
		{
			var draft = readDraft();
			var material = Material(review, draft);
			await gateway.ChangeCredentialAsync(review.Target, draft.Provider, review.ExpectedRevision, material, () => dispatched = true, cancellation);
			if (material is null)
				summary = "Azure acknowledged the provider removal request. Registrations and other providers were preserved. Refresh status and verify removal before relying on disabled delivery.";
		}
		catch (Exception error)
		{
			var rejected = failures.Classify(error).Rejected;
			status = dispatched && !rejected ? "unknown" : error is OperationCanceledException && cancellation.IsCancellationRequested ? "cancelled" : "failed";
			summary = status == "unknown" ? "Azure may have accepted the provider change. Nothing was retried. Check the retained receipt and Azure state before another change; redacted credential status cannot prove which key is active."
				: status == "cancelled" ? "Cancelled before a credential write was dispatched."
				: error is OperationException protocol ? protocol.Message
				: "Provider configuration failed or was rejected. Check permissions, credential validity and connectivity. Credential contents were withheld; nothing was retried.";
		}
		var result = new NotificationHubOutcome(review.Id, review.Target, "credentials", status, summary);
		receipts.Add(review.Id, stamp, result);
		return result;
	}
}
