using System.Text;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.BodyTools;

namespace MsgCommander.Application.BodyTools;

public static class BodyConversionService
{
	public const int Limit = 262144;
	private static OperationException Invalid() => new(OperationFailure.InvalidInput, "Body conversion failed. Check the selected format and encoding. Malformed, unsupported or oversized bodies are retained as original bytes.");
	private static Encoding TextEncoding(string name, bool bom = false) => name switch
	{
		"utf8" => new UTF8Encoding(bom, true),
		"ascii" => Encoding.GetEncoding("us-ascii", EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback),
		"utf16le" => new UnicodeEncoding(false, bom, true),
		"utf16be" => new UnicodeEncoding(true, bom, true),
		"utf32le" => new UTF32Encoding(false, bom, true),
		"utf32be" => new UTF32Encoding(true, bom, true),
		_ => throw Invalid()
	};
	private static string Text(byte[] bytes, Encoding encoding)
	{
		var expected = encoding.GetPreamble();
		if (expected.Length > 0 && bytes.AsSpan().StartsWith(expected))
			return encoding.GetString(bytes, expected.Length, bytes.Length - expected.Length);
		byte[][] marks = [[0xff, 0xfe, 0, 0], [0, 0, 0xfe, 0xff], [0xef, 0xbb, 0xbf], [0xff, 0xfe], [0xfe, 0xff]];
		foreach (var mark in marks)
			if (bytes.AsSpan().StartsWith(mark))
				throw Invalid();
		return encoding.GetString(bytes);
	}

	public static BodyCodecResult ConvertBody(BodyCodecRequest request, CancellationToken token)
	{
		try
		{
			var direction = request.Direction;
			var format = request.Format;
			var encoding = TextEncoding(request.Encoding, true);
			var bom = request.Bom;
			var encoded = request.ContentBase64;
			if (encoded.Length > 349528)
				throw Invalid();
			var bytes = Convert.FromBase64String(encoded);
			if (bytes.Length > Limit || Convert.ToBase64String(bytes) != encoded || direction is not ("decode" or "encode"))
				throw Invalid();
			token.ThrowIfCancellationRequested();
			byte[] result;
			string kind;
			if (format == "bytes")
			{
				result = bytes;
				kind = "bytes";
			}
			else if (format == "text")
			{
				if (direction == "decode")
				{
					result = new UTF8Encoding(false, true).GetBytes(Text(bytes, encoding));
					kind = "text";
				}
				else
				{
					var text = Text(bytes, TextEncoding("utf8", true));
					var target = TextEncoding(request.Encoding, bom);
					if (target.GetByteCount(text) + target.GetPreamble().Length > Limit)
						throw Invalid();
					result = [.. target.GetPreamble(), .. target.GetBytes(text)];
					kind = "bytes";
				}
			}
			else
				throw Invalid();
			if (result.Length > Limit)
				throw Invalid();
			return new(Convert.ToBase64String(result), kind, []);
		}
		catch (Exception error) when (error is FormatException or ArgumentException or InvalidOperationException or NotSupportedException)
		{
			throw Invalid();
		}
	}
}
