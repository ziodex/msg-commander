using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Application.AccessPolicies;
using MsgCommander.Application.Relay.Management;
using MsgCommander.Application.Relay.Hybrid;
using MsgCommander.Contracts.Relay.Management;
using MsgCommander.Contracts.Relay.Hybrid;
using MsgCommander.Contracts.Relay.Configuration;
using MsgCommander.Contracts.Common;
using MsgCommander.Contracts.Connections;
using MsgCommander.Contracts.AccessPolicies;

namespace MsgCommander.Application.Relay.Hybrid;

public static class HybridRunRules
{
	public const int BodyLimit = 16384;
	public static byte[] Bytes(this HybridRun value) => value.Encoding == "base64" ? Convert.FromBase64String(value.Body) : System.Text.Encoding.UTF8.GetBytes(value.Body);
	public static void Validate(this HybridRun value)
	{
		new RelayScope("hybrid", value.Name).Validate();
		if (!Guid.TryParse(value.Id, out _) || !Guid.TryParse(value.ProfileId, out _) || !value.Acknowledged || value.Mode is not ("http-send" or "http-listen" or "stream-send" or "stream-listen") || value.Method is not ("GET" or "POST" or "PUT" or "PATCH" or "DELETE" or "HEAD" or "OPTIONS") || value.Body is null || value.Body.Length > 22000 || value.Encoding is not ("utf8" or "base64") || value.Headers is null || value.Headers.Count > 16 || value.ResponseStatus is < 200 or > 599 || value.MaxCount is < 1 or > 100 || value.MaxSeconds is < 1 or > 600 || value.ExchangeSeconds is < 1 or > 60)
			throw Invalid();
		byte[] bytes;
		try
		{
			bytes = value.Bytes();
		}
		catch (FormatException)
		{
			throw Invalid();
		}

		if (bytes.Length > HybridRunRules.BodyLimit || (value.Encoding == "base64" && Convert.ToBase64String(bytes) != value.Body) || value.Headers.Any(h => !ValidHeader(h) || !AllowedHeader(h.Name)) || value.Headers.Select(h => h.Name.ToLowerInvariant()).Distinct().Count() != value.Headers.Count || JsonSerializer.SerializeToUtf8Bytes(value.Headers).Length > 4096 || (value.Mode.StartsWith("stream", StringComparison.Ordinal) && value.Headers.Count > 0) || (value.Mode == "http-send" && value.Method is "GET" or "HEAD" && value.Body.Length > 0) || (value.Mode == "http-listen" && value.ResponseStatus is 204 or 304 && value.Body.Length > 0))
			throw Invalid();
	}

	public static bool ValidHeader(HybridHeader h) => h is not null && h.Name is not null && h.Value is not null && Regex.IsMatch(h.Name, @"^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$") && h.Value.Length <= 1024 && Regex.IsMatch(h.Value, @"^[\x20-\x7e]*$");
	public static bool AllowedHeader(string name) => !Regex.IsMatch(name, @"^(authorization|proxy-authorization|servicebusauthorization|host|connection|upgrade|content-length|transfer-encoding|trailer|te|expect|cookie|set-cookie)$", RegexOptions.IgnoreCase) && !Regex.IsMatch(name, @"^(sec-|sb-)", RegexOptions.IgnoreCase);
	public static OperationException Invalid() => new(OperationFailure.InvalidInput, "Check the Hybrid Connection name, job limits, body (16 KiB) and permitted HTTP headers.");
}
