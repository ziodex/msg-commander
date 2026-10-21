namespace MsgCommander.Contracts.BodyTools;

public sealed record BodyCodecRequest(string Direction, string Format, string Encoding, bool Bom, string ContentBase64);
public sealed record BodyCodecResult(string ContentBase64, string Kind, IReadOnlyList<string> Warnings);
