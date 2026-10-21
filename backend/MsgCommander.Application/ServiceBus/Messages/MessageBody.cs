using System.Text;

namespace MsgCommander.Application.ServiceBus.Messages;

/// <summary>A lazy byte view. Unsupported broker body forms fail only when bytes are requested.</summary>
public abstract class MessageBody
{
	public abstract ReadOnlyMemory<byte> ToMemory();
	public byte[] ToArray() => ToMemory().ToArray();
	public override string ToString() => Encoding.UTF8.GetString(ToMemory().Span);
	public static MessageBody FromBytes(ReadOnlyMemory<byte> bytes) => new MemoryBody(bytes);
	private sealed class MemoryBody(ReadOnlyMemory<byte> bytes) : MessageBody
	{
		public override ReadOnlyMemory<byte> ToMemory() => bytes;
	}
}
