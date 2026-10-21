namespace MsgCommander.Contracts.Connections;

public sealed record ConnectionProfile(string Id, string Name, string Service, string Namespace, string Auth,
	string TenantId, string ClientId, string? Secret, int? EmulatorManagementPort = null);

public sealed record NamespaceConnection(string ConnectionId, string ProfileId, string Namespace, string ConnectedAt);

public sealed record DeviceCodeEvent(string Code, string ExpiresOn);
public sealed record AuthenticationCheck(string Summary);
