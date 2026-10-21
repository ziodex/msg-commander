namespace MsgCommander.Domain.Connections;

public readonly record struct ConnectionIdentity
{
	private ConnectionIdentity(string value) => Value = value;

	public string Value
	{
		get;
	}

	public static ConnectionIdentity Create() => new(Guid.NewGuid().ToString());

	public bool Matches(string? candidate) => !string.IsNullOrEmpty(Value) && string.Equals(Value, candidate, StringComparison.Ordinal);
}
