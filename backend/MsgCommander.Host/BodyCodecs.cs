using System.Text.Json;
using MsgCommander.Application.BodyTools;
using MsgCommander.Contracts.BodyTools;

namespace MsgCommander.Host;

internal static class BodyCodecs
{
	public static BodyCodecResult ConvertBody(JsonElement input, CancellationToken token)
	{
		string[] fields = ["direction", "format", "encoding", "bom", "contentBase64"];
		if (input.ValueKind != JsonValueKind.Object || input.EnumerateObject().Count() != fields.Length || input.EnumerateObject().Any(p => !fields.Contains(p.Name)) || fields.Any(name => !input.TryGetProperty(name, out _)) || input.GetProperty("bom").ValueKind is not (JsonValueKind.True or JsonValueKind.False) || fields.Where(name => name != "bom").Any(name => input.GetProperty(name).ValueKind != JsonValueKind.String))
			throw new OperationException(OperationFailure.InvalidInput, "Body conversion failed. Check the selected format and encoding. Malformed, unsupported or oversized bodies are retained as original bytes.");
		return BodyConversionService.ConvertBody(new(input.GetProperty("direction").GetString()!, input.GetProperty("format").GetString()!, input.GetProperty("encoding").GetString()!, input.GetProperty("bom").GetBoolean(), input.GetProperty("contentBase64").GetString()!), token);
	}
}
