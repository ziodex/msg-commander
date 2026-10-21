using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.Connections;
namespace MsgCommander.Application.EventHubs.Connections;

public sealed record IotHubEndpoint(string Namespace, string HubName, string ConnectionString)
{
	public override string ToString() => "IoT Hub endpoint (credentials omitted)";
	private static OperationException Invalid() => new(OperationFailure.InvalidInput, "Use the Event Hubs-compatible connection string from IoT Hub Built-in endpoints, with Endpoint, SharedAccessKeyName, SharedAccessKey and EntityPath. A ServiceConnect policy is required; HostName/device strings are not supported here.");
	public static IotHubEndpoint Parse(string? value)
	{
		if (string.IsNullOrWhiteSpace(value) || value.Length > 8192 || value.IndexOfAny(['\r', '\n', '\0']) >= 0)
			throw Invalid();
		var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
		value = value.Trim();
		if (value.EndsWith(';'))
			value = value[..^1];
		foreach (var part in value.Split(';'))
		{
			var at = part.IndexOf('=');
			if (at < 1)
				throw Invalid();
			var name = part[..at].Trim();
			var content = part[(at + 1)..].Trim();
			if (!new[] { "Endpoint", "SharedAccessKeyName", "SharedAccessKey", "EntityPath" }.Contains(name, StringComparer.OrdinalIgnoreCase) || string.IsNullOrEmpty(content) || !fields.TryAdd(name, content))
				throw Invalid();
		}
		if (fields.Count != 4)
			throw Invalid();
		var match = Regex.Match(fields["Endpoint"], @"^sb://([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.servicebus\.windows\.net)/?$", RegexOptions.IgnoreCase);
		if (!match.Success || !Regex.IsMatch(fields["EntityPath"], @"^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$") || !Regex.IsMatch(fields["SharedAccessKeyName"], @"^[A-Za-z0-9_.-]{1,256}$"))
			throw Invalid();
		try
		{
			var bytes = Convert.FromBase64String(fields["SharedAccessKey"]);
			if (bytes.Length == 0 || Convert.ToBase64String(bytes) != fields["SharedAccessKey"])
				throw Invalid();
		}
		catch (FormatException) { throw Invalid(); }
		var host = match.Groups[1].Value.ToLowerInvariant();
		return new(host, fields["EntityPath"], $"Endpoint=sb://{host}/;SharedAccessKeyName={fields["SharedAccessKeyName"]};SharedAccessKey={fields["SharedAccessKey"]};EntityPath={fields["EntityPath"]}");
	}
	public static IotHubEndpoint Validate(ConnectionProfile profile)
	{
		if (profile.Service != "iot-hub" || profile.Auth != "sas")
			throw new OperationException(OperationFailure.InvalidInput, "IoT Hub built-in endpoint listening requires an IoT Hub profile with a ServiceConnect connection string.");
		var endpoint = Parse(profile.Secret);
		if (!string.Equals(endpoint.Namespace, profile.Namespace, StringComparison.OrdinalIgnoreCase))
			throw new OperationException(OperationFailure.InvalidInput, "The IoT Hub compatible endpoint must match this profile hostname.");
		return endpoint;
	}
}
