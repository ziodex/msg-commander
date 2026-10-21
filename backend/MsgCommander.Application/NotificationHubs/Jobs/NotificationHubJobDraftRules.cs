using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.NotificationHubs.Management;
using MsgCommander.Contracts.NotificationHubs.Registrations;
using MsgCommander.Contracts.NotificationHubs.RegistrationFiles;
using MsgCommander.Contracts.NotificationHubs.Jobs;
using MsgCommander.Contracts.NotificationHubs.Notifications;
using MsgCommander.Contracts.Connections;
using MsgCommander.Application.AccessPolicies;
using MsgCommander.Application.NotificationHubs.Management;

namespace MsgCommander.Application.NotificationHubs.Jobs;

public static class NotificationHubJobDraftRules
{
	public static readonly string[] Types = ["ExportRegistrations", "ImportCreateRegistrations", "ImportUpdateRegistrations", "ImportDeleteRegistrations", "ImportUpsertRegistrations"];
	public static void Validate(this NotificationHubJobDraft value)
	{
		if (!Types.Contains(value.Type) || (value.Type == "ExportRegistrations") != (value.ImportFileUri is null))
			throw new OperationException(OperationFailure.InvalidInput, "Export needs only an output container; import needs an input blob and output container.");
		StorageUri(value.OutputContainerUri, true);
		if (value.ImportFileUri is not null)
			StorageUri(value.ImportFileUri, false);
	}

	public static Uri StorageUri(string value, bool output)
	{
		var message = "Use an unexpired HTTPS Azure Blob SAS URL: a container with write/list permissions for output, or a readable blob for input.";
		if (string.IsNullOrWhiteSpace(value) || value.Length > 8192 || value.Any(char.IsWhiteSpace) || value.Contains('\\') || !Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo != "" || uri.Fragment != "" || !Regex.IsMatch(uri.Host, @"^[a-z0-9]{3,24}\.blob\.core\.windows\.net$"))
			throw new OperationException(OperationFailure.InvalidInput, message);
		var path = uri.AbsolutePath.Trim('/').Split('/');
		if (!Regex.IsMatch(path[0], @"^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$") || path[0].Contains("--") || (output ? path.Length != 1 : path.Length < 2) || path.Any(p => string.IsNullOrEmpty(p) || Uri.UnescapeDataString(p) is "." or ".."))
			throw new OperationException(OperationFailure.InvalidInput, message);
		var query = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
		foreach (var item in uri.Query.TrimStart('?').Split('&'))
		{
			var pair = item.Split('=', 2);
			if (pair.Length != 2 || !query.TryAdd(Uri.UnescapeDataString(pair[0]), Uri.UnescapeDataString(pair[1])))
				throw new OperationException(OperationFailure.InvalidInput, message);
		}

		if (!query.TryGetValue("sig", out var signature) || string.IsNullOrWhiteSpace(signature) || !query.TryGetValue("sv", out var version) || string.IsNullOrWhiteSpace(version) || !query.TryGetValue("se", out var expiry) || !DateTimeOffset.TryParse(expiry, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var expires) || expires <= DateTimeOffset.UtcNow.AddMinutes(1) || !query.TryGetValue("sp", out var permissions) || (output ? !permissions.Contains('w') || !permissions.Contains('l') : !permissions.Contains('r')) || !query.TryGetValue("sr", out var resource) || (output ? resource != "c" : resource is not ("b" or "c")) || query.TryGetValue("spr", out var protocol) && protocol != "https" || query.TryGetValue("st", out var start) && (!DateTimeOffset.TryParse(start, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var starts) || starts > DateTimeOffset.UtcNow))
			throw new OperationException(OperationFailure.InvalidInput, message);
		return uri;
	}

	// Only validated public Blob locations are projected. SAS queries and service failure text never leave the host.
	public static string? PublicLocation(string? value)
	{
		if (value is null || value.Length > 8192 || value.Any(char.IsControl) || !Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo != "" || !Regex.IsMatch(uri.Host, @"^[a-z0-9]{3,24}\.blob\.core\.windows\.net$"))
			return null;
		return uri.GetLeftPart(UriPartial.Path);
	}

	public static void ValidateJobId(string id)
	{
		if (id is null || !Regex.IsMatch(id, @"^[A-Za-z0-9_-]{1,128}$"))
			throw new OperationException(OperationFailure.InvalidInput, "Enter an Azure job ID using letters, digits, hyphens or underscores.");
	}
}
