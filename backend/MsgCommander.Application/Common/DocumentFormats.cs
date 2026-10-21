namespace MsgCommander.Application.Common;

public static class DocumentFormats
{
	// Earlier exports remain readable. Writers always use the current format identifier.
	public static bool Matches(string? actual, string expected) =>
		actual == expected || actual == "service-bus-commander/" + expected["msg-commander/".Length..];
}
