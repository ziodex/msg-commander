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

namespace MsgCommander.Application.Relay.Configuration;

public static class RelayConfiguration
{
	public const int FileLimit = 262144;
	public const string Format = "msg-commander/relay";
	public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
	{
		UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow,
		RespectRequiredConstructorParameters = true
	};
	private static OperationException Invalid() => new(OperationFailure.InvalidInput, "Invalid Relay configuration. Use Commander Relay JSON v1; check required settings, duplicate names and the 100-target / 256 KiB limits.");
	public static RelayConfigArchive Decode(string base64)
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
					foreach (var value in node.EnumerateArray())
						Unique(value);
			}

			Unique(doc.RootElement);
			var archive = doc.RootElement.Deserialize<RelayConfigArchive>(Json)!;
			Validate(archive);
			return archive with
			{
				Format = Format
			};
		}
		catch (OperationException)
		{
			throw Invalid();
		}
		catch (Exception error) when (error is JsonException or FormatException or DecoderFallbackException or InvalidOperationException or ArgumentException or NullReferenceException)
		{
			throw Invalid();
		}
	}

	public static void Validate(RelayConfigArchive archive)
	{
		if (!DocumentFormats.Matches(archive.Format, Format) || archive.Version != 1 || !DateTimeOffset.TryParse(archive.ExportedAt, out _) || archive.SourceNamespace is null || archive.SourceNamespace.Length > 253 || archive.Resources is null || archive.NamespacePolicies is null || archive.Warnings is null || archive.Warnings.Count > 100 || archive.Warnings.Any(w => w is null || w.Length > 512))
			throw Invalid();
		var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
		var count = 0;
		void Policy(RelayScope scope, RelayConfigPolicy p)
		{
			new RelayTarget(scope, p.Name).Validate();
			AccessPolicyRules.Rights(p.Rights);
			if (!names.Add(JsonSerializer.Serialize(new RelayTarget(scope, p.Name), Json)))
				throw Invalid();
			if (++count > 100)
				throw Invalid();
		}

		foreach (var resource in archive.Resources)
		{
			var scope = new RelayScope(resource.Kind, resource.Name);
			scope.Validate();
			if (scope.Kind == "namespace" || !names.Add(JsonSerializer.Serialize(new RelayTarget(scope, null), Json)) || ++count > 100 || resource.Policies is null)
				throw Invalid();
			resource.Settings?.Validate(scope.Kind);
			foreach (var p in resource.Policies)
				Policy(scope, p);
		}

		foreach (var p in archive.NamespacePolicies)
			Policy(new("namespace", ""), p);
		if (count == 0)
			throw Invalid();
	}

	public static byte[] Encode(RelayConfigArchive archive, string format)
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
