using Azure.Messaging.ServiceBus;

namespace MsgCommander.Infrastructure.ServiceBus;

internal static class ServiceBusEndpoint
{
	public static (string Administration, ServiceBusTransportType Transport) Resolve(ConnectionProfile profile)
	{
		var parsed = ServiceBusConnectionStringProperties.Parse(profile.Secret);
		if (!string.Equals(parsed.FullyQualifiedNamespace, profile.Namespace, StringComparison.OrdinalIgnoreCase) || !string.IsNullOrEmpty(parsed.EntityPath))
			throw new OperationException(OperationFailure.InvalidInput, "Use a matching namespace connection string without EntityPath.");
		var emulator = System.Text.RegularExpressions.Regex.IsMatch(profile.Secret!, @"(?:^|;)\s*UseDevelopmentEmulator\s*=\s*true\s*(?:;|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
		if (emulator != profile.EmulatorManagementPort.HasValue)
			throw new OperationException(OperationFailure.InvalidInput, "Select Local emulator and use UseDevelopmentEmulator=true for emulator connections.");
		if (!emulator)
			return (profile.Secret!, ServiceBusTransportType.AmqpWebSockets);
		if (profile.EmulatorManagementPort is not (>= 1 and <= 65535))
			throw new OperationException(OperationFailure.InvalidInput, "Use an emulator management port from 1 to 65535.");
		var endpoint = new UriBuilder(parsed.Endpoint) { Port = profile.EmulatorManagementPort.Value };
		var administration = string.Join(';', profile.Secret!.Split(';').Where(part => !part.TrimStart().StartsWith("Endpoint=", StringComparison.OrdinalIgnoreCase)))
			+ ";Endpoint=" + endpoint.Uri.AbsoluteUri;
		return (administration, ServiceBusTransportType.AmqpTcp);
	}
}
