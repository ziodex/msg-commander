using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.EventGrid.Publishing;
using MsgCommander.Domain.EventGrid;

namespace MsgCommander.Application.EventGrid.Publishing;

public static class OutgoingCloudEvents
{
	private static OperationException Invalid() => new(OperationFailure.InvalidInput, "Use valid CloudEvents 1.0 attributes, unique extension names and JSON, text or base64 data. Nothing was sent.");
	private static readonly string[] Reserved = ["id", "source", "specversion", "type", "subject", "time", "datacontenttype", "dataschema", "data", "data_base64"];
	private static bool Attribute(string? s) => s is not null && s.Length <= 4096 && !s.Any(c => char.IsControl(c) || c is >= '\ufdd0' and <= '\ufdef') && ValidUnicode(s);
	private static bool ValidUnicode(string s)
	{
		foreach (var rune in s.EnumerateRunes())
			if ((rune.Value & 0xffff) >= 0xfffe)
				return false;
		for (var i = 0; i < s.Length; i++)
		{
			if (char.IsHighSurrogate(s[i]))
			{
				if (++i >= s.Length || !char.IsLowSurrogate(s[i]))
					return false;
			}
			else if (char.IsLowSurrogate(s[i]))
				return false;
		}
		return true;
	}
	private static bool Reference(string s) => Attribute(s) && Regex.IsMatch(s, @"^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*$") && !Regex.IsMatch(s, @"%(?![a-fA-F0-9]{2})") && Uri.TryCreate(s, UriKind.RelativeOrAbsolute, out _);
	public static byte[] Build(CloudEventDraft d)
	{
		if (!Attribute(d.Id) || string.IsNullOrWhiteSpace(d.Id) || !Reference(d.Source) || string.IsNullOrWhiteSpace(d.Source) || !Attribute(d.Type) || string.IsNullOrWhiteSpace(d.Type) || !Attribute(d.Subject) || !Attribute(d.DataContentType) || !Attribute(d.Time) || !Reference(d.DataSchema) || (d.DataSchema != "" && !Uri.TryCreate(d.DataSchema, UriKind.Absolute, out _)) || d.Data is null || d.Data.Length > 262144 || d.Properties is null || d.Properties.Count > 32)
			throw Invalid();
		if (d.Time != "" && (!Regex.IsMatch(d.Time, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$") || !DateTimeOffset.TryParse(d.Time, CultureInfo.InvariantCulture, DateTimeStyles.None, out _)))
			throw Invalid();
		if (d.DataContentType != "" && !MediaTypeHeaderValue.TryParse(d.DataContentType, out _))
			throw Invalid();
		var names = new HashSet<string>(Reserved, StringComparer.Ordinal);
		using var output = new MemoryStream();
		using (var w = new Utf8JsonWriter(output, new()
		{
			Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
		}))
		{
			w.WriteStartObject();
			w.WriteString("specversion", "1.0");
			w.WriteString("id", d.Id);
			w.WriteString("source", d.Source);
			w.WriteString("type", d.Type);
			foreach (var (key, value) in new[] { ("subject", d.Subject), ("time", d.Time), ("datacontenttype", d.DataContentType), ("dataschema", d.DataSchema) })
				if (value != "")
					w.WriteString(key, value);
			foreach (var p in d.Properties)
			{
				if (p is null || p.Name is null || !Regex.IsMatch(p.Name, @"^[a-z0-9]{1,20}$") || !names.Add(p.Name) || !Attribute(p.Value))
					throw Invalid();
				if (p.Type == "string")
					w.WriteString(p.Name, p.Value);
				else if (p.Type == "boolean" && p.Value is "true" or "false")
					w.WriteBoolean(p.Name, p.Value == "true");
				else if (p.Type == "integer" && Regex.IsMatch(p.Value, @"^-?(0|[1-9][0-9]*)$") && int.TryParse(p.Value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var number))
					w.WriteNumber(p.Name, number);
				else
					throw Invalid();
			}
			switch (d.DataMode)
			{
				case "none":
					if (d.Data != "")
						throw Invalid();
					break;
				case "text":
					w.WriteString("data", d.Data);
					break;
				case "base64":
					if (!Regex.IsMatch(d.Data, @"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"))
						throw Invalid();
					w.WriteString("data_base64", d.Data);
					break;
				case "json":
					try
					{
						using var doc = JsonDocument.Parse(d.Data, new()
						{
							MaxDepth = 32
						});
						Unique(doc.RootElement);
						if (d.DataContentType != "" && !Regex.IsMatch(d.DataContentType.Split(';')[0].Trim(), @"/(?:[^/]+\+)?json$", RegexOptions.IgnoreCase) && doc.RootElement.ValueKind != JsonValueKind.String)
							throw Invalid();
						w.WritePropertyName("data");
						w.WriteRawValue(d.Data);
					}
					catch (JsonException) { throw Invalid(); }
					break;
				default:
					throw Invalid();
			}
			w.WriteEndObject();
		}
		if (output.Length > 524288)
			throw Invalid();
		return output.ToArray();
	}
	private static void Unique(JsonElement e)
	{
		if (e.ValueKind == JsonValueKind.Object)
		{
			var seen = new HashSet<string>();
			foreach (var p in e.EnumerateObject())
			{
				if (!seen.Add(p.Name))
					throw Invalid();
				Unique(p.Value);
			}
		}
		else if (e.ValueKind == JsonValueKind.Array)
			foreach (var item in e.EnumerateArray())
				Unique(item);
	}
	public static byte[][] Validate(EventGridPublish p)
	{
		if (!Guid.TryParse(p.Id, out _) || !Guid.TryParse(p.ConnectionId, out _) || !EventGridAddress.IsName(p.TopicName) || p.Mode is not ("single" or "batch") || p.Drafts is null || p.Drafts.Count is < 1 or > 100 || (p.Mode == "single" && p.Drafts.Count != 1) || p.BatchSize is < 1 or > 100 || p.MaxSeconds is < 1 or > 300 || p.DelayMs is < 0 or > 1000 || !p.Acknowledged)
			throw Invalid();
		if (p.Drafts.Any(d => d is null) || p.Drafts.Select(d => (d.Source, d.Id)).Distinct().Count() != p.Drafts.Count)
			throw Invalid();
		return p.Drafts.Select(Build).ToArray();
	}
	public static byte[] Batch(IReadOnlyList<byte[]> events) => Encoding.UTF8.GetBytes("[" + string.Join(",", events.Select(Encoding.UTF8.GetString)) + "]");
}
