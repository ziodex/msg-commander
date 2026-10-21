using MsgCommander.Application.Common;
using MsgCommander.Application.AccessPolicies;
using MsgCommander.Application.NotificationHubs.Management;
using MsgCommander.Contracts.NotificationHubs.Management;
using MsgCommander.Contracts.NotificationHubs.Configuration;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
namespace MsgCommander.Application.NotificationHubs.Configuration;

public static class NotificationHubConfiguration
{
	public const int FileLimit = 262144;
	public const string Format = "msg-commander/notification-hubs";
	public const string Exclusions = "SAS keys, provider credentials, registrations and installations are excluded. New policies receive Azure-generated keys; existing policy keys and provider credentials are preserved.";
	public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow, RespectRequiredConstructorParameters = true };
	private static OperationException Invalid() => new(OperationFailure.InvalidInput, "Invalid Notification Hubs configuration. Use Commander JSON v1; check required settings, duplicate targets and the 100-target / 256 KiB limits.");
	public static NotificationHubConfigArchive Decode(string base64)
	{
		try
		{
			if (base64.Length > 349528)
				throw Invalid();
			var bytes = Convert.FromBase64String(base64);
			if (bytes.Length > FileLimit)
				throw Invalid();
			var text = new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF', ' ', '\r', '\n', '\t');
			if (!text.StartsWith('{'))
				throw Invalid();
			using var doc = JsonDocument.Parse(text, new()
			{
				MaxDepth = 24
			});
			static void Unique(JsonElement node)
			{
				if (node.ValueKind == JsonValueKind.Object)
				{
					var names = new HashSet<string>(StringComparer.Ordinal);
					foreach (var p in node.EnumerateObject())
					{
						if (!names.Add(p.Name))
							throw Invalid();
						Unique(p.Value);
					}
				}
				else if (node.ValueKind == JsonValueKind.Array)
					foreach (var v in node.EnumerateArray())
						Unique(v);
			}
			Unique(doc.RootElement);
			var archive = doc.RootElement.Deserialize<NotificationHubConfigArchive>(Json)!;
			Validate(archive);
			// File-provided warning text is not trusted diagnostic output.
			archive = archive with
			{
				Warnings = [Exclusions, "Review current and proposed Azure tags. Unlisted policies and unrelated hub properties are preserved."]
			};
			Validate(archive);
			return archive with
			{
				Format = Format
			};
		}
		catch (OperationException) { throw Invalid(); }
		catch (Exception e) when (e is JsonException or FormatException or DecoderFallbackException or InvalidOperationException or ArgumentException or NullReferenceException) { throw Invalid(); }
	}
	public static void Validate(NotificationHubConfigArchive archive)
	{
		if (!DocumentFormats.Matches(archive.Format, Format) || archive.Version != 1 || !DateTimeOffset.TryParse(archive.ExportedAt, out _) || archive.SourceNamespace is null || archive.SourceNamespace.Length > 253 || (archive.SourceNamespace != "Unknown" && !Regex.IsMatch(archive.SourceNamespace, @"^[A-Za-z][A-Za-z0-9-]{0,49}(?:\.servicebus\.windows\.net)?$")) || archive.Resources is null || archive.NamespacePolicies is null || archive.Warnings is null || archive.Warnings.Count > 100 || archive.Warnings.Any(w => w is null || w.Length > 512))
			throw Invalid();
		var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
		var count = 0;
		void Policy(NotificationHubScope scope, NotificationHubConfigPolicy policy)
		{
			new NotificationHubTarget(scope, policy.Name).Validate();
			AccessPolicyRules.Rights(policy.Rights);
			if (!names.Add(JsonSerializer.Serialize(new NotificationHubTarget(scope, policy.Name), Json)) || ++count > 100)
				throw Invalid();
		}
		foreach (var r in archive.Resources)
		{
			var scope = new NotificationHubScope("hub", r.Name);
			scope.Validate();
			if (!names.Add(JsonSerializer.Serialize(new NotificationHubTarget(scope, null), Json)) || ++count > 100 || r.Policies is null)
				throw Invalid();
			r.Settings?.Validate();
			foreach (var p in r.Policies)
				Policy(scope, p);
		}
		foreach (var p in archive.NamespacePolicies)
			Policy(new("namespace", ""), p);
		if (count == 0)
			throw Invalid();
	}

	public static byte[] Encode(NotificationHubConfigArchive archive, string format)
	{
		Validate(archive);
		if (format != "json")
			throw Invalid();
		var bytes = JsonSerializer.SerializeToUtf8Bytes(archive with
		{
			Format = Format
		}, new JsonSerializerOptions(Json) { WriteIndented = true });
		if (bytes.Length > FileLimit)
			throw new OperationException(OperationFailure.OperationBlocked, "Configuration exceeds the file limit. Export a smaller scope.");
		return bytes;
	}
}
