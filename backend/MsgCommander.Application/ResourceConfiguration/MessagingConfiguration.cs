using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.ResourceConfiguration;
using MsgCommander.Contracts.EventHubs.Administration;
using MsgCommander.Contracts.ServiceBus.Entities;
using MsgCommander.Contracts.ServiceBus.Rules;

namespace MsgCommander.Application.ResourceConfiguration;

public static partial class MessagingConfiguration
{
	public const int FileLimit = 524288, TargetLimit = 100;
	public const string Format = "msg-commander/messaging-configuration";
	public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow, RespectRequiredConstructorParameters = true };
	public static OperationException Invalid() => new(OperationFailure.InvalidInput, "Invalid or unsupported messaging configuration. Choose Commander messaging JSON v1; check duplicate names/fields and the 100-target / 512 KiB limits.");
	public static JsonElement Value(object value) => JsonSerializer.SerializeToElement(value, Json);
	public static void Unique(JsonElement node)
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
			foreach (var child in node.EnumerateArray())
				Unique(child);
	}
	public static MessagingConfigArchive Decode(string base64, string service)
	{
		try
		{
			if (base64.Length > 699052)
				throw Invalid();
			var bytes = Convert.FromBase64String(base64);
			if (bytes.Length > FileLimit)
				throw Invalid();
			var text = new UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF', ' ', '\n', '\r', '\t');
			if (!text.StartsWith('{'))
				throw Invalid();
			using var document = JsonDocument.Parse(text, new()
			{
				MaxDepth = 24
			});
			Unique(document.RootElement);
			var archive = document.RootElement.Deserialize<MessagingConfigArchive>(Json)!;
			Validate(archive, service);
			return archive with
			{
				Format = Format
			};
		}
		catch (OperationException) { throw; }
		catch (Exception e) when (e is JsonException or FormatException or ArgumentException or InvalidOperationException or OverflowException or NullReferenceException) { throw Invalid(); }
	}
	public static void Validate(MessagingConfigArchive archive, string service)
	{
		if (!DocumentFormats.Matches(archive.Format, Format) || archive.Version != 1 || archive.Service != service || !DateTimeOffset.TryParse(archive.ExportedAt, out _) || archive.SourceNamespace is null || archive.SourceNamespace.Length > 253 || !Regex.IsMatch(archive.SourceNamespace, @"^(Unknown|[a-zA-Z0-9-]+(?:\.servicebus\.windows\.net)?)$") || archive.Resources is null || archive.Resources.Count is < 1 or > TargetLimit || archive.Warnings is null || archive.Warnings.Count > 100 || archive.Warnings.Any(w => w is null || w.Length > 512))
			throw Invalid();
		var keys = new HashSet<string>();
		foreach (var r in archive.Resources)
		{
			r.Target.Validate(service);
			if (!keys.Add(r.Target.Key()) || r.Settings.ValueKind != JsonValueKind.Object || r.Issue?.Length > 512 || r.Target.Kind != "subscription" && r.RulesSpecified)
				throw Invalid();
			var allowed = r.Target.Kind switch
			{
				"queue" or "topic" or "subscription" => typeof(EntitySettings).GetProperties().Select(p => JsonNamingPolicy.CamelCase.ConvertName(p.Name)),
				"hub" => typeof(EventHubSettings).GetProperties().Select(p => JsonNamingPolicy.CamelCase.ConvertName(p.Name)),
				"rule" => typeof(RuleDefinition).GetProperties().Select(p => JsonNamingPolicy.CamelCase.ConvertName(p.Name)),
				"policy" => new[] { "rights" },
				_ => new[] { "userMetadata" }
			};
			if (r.Settings.EnumerateObject().Any(p => !allowed.Contains(p.Name)))
				throw Invalid();
		}
	}
	public static JsonElement Merge(JsonElement current, JsonElement patch)
	{
		var fields = current.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.Clone());
		foreach (var p in patch.EnumerateObject())
			fields[p.Name] = p.Value.Clone();
		return Value(fields);
	}
	public static EntitySettings DefaultEntity(string kind)
	{
		var receive = kind != "topic";
		var send = kind != "subscription";
		return new("Active", "unlimited", "disabled", true, "", receive ? "00:01:00" : null, receive ? 10 : null, receive ? false : null, receive ? "" : null, receive ? "" : null, receive ? false : null,
			send ? 1024 : null, null, send ? false : null, send ? "00:10:00" : null, send ? false : null, kind == "topic" ? false : null, kind == "subscription" ? true : null);
	}
	public static RuleDefinition MatchAll => new("true", "", [], null, "", []);
	public static byte[] Encode(MessagingConfigArchive archive, string format)
	{
		Validate(archive, archive.Service);
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
