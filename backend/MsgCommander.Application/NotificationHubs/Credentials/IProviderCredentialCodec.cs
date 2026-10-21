using MsgCommander.Contracts.NotificationHubs.Management;

namespace MsgCommander.Application.NotificationHubs.Credentials;

/// <summary>Opaque integration material. Core code owns its lifetime without reading provider secrets.</summary>
public abstract class ProviderCredentialMaterial(string provider)
{
	public string Provider { get; } = provider;
	public override string ToString() => $"{Provider} credential material";
}
public sealed record ImportedProviderCredential(ProviderCredentialMaterial Material, string Summary, DateTimeOffset? NotAfter);
public sealed record ProviderCredentialDraft(string Provider, bool? Remove, IReadOnlyDictionary<string, string?> Fields)
{
	public override string ToString() => $"{Provider} credential draft";
}
public sealed record ProviderCredentialReview(string Id, NotificationHubTarget Target, string ExpectedRevision, bool Acknowledged);
public interface IProviderCredentialCodec
{
	ImportedProviderCredential Import(string provider, byte[] bytes, string password);
	ProviderCredentialMaterial Build(ProviderCredentialDraft draft, ProviderCredentialMaterial? imported);
}
