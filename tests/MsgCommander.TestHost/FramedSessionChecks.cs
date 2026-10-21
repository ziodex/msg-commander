using System.Buffers.Binary;
using System.Text.Json;
using MsgCommander.Host.Transport;

static class FramedSessionChecks
{
	sealed class Input(byte[] frame) : MemoryStream(frame)
	{
		public readonly TaskCompletionSource Closed = new(TaskCreationOptions.RunContinuationsAsynchronously);
		public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
		{
			if (Position < Length)
				return await base.ReadAsync(buffer, cancellationToken);
			await Closed.Task.WaitAsync(cancellationToken);
			return 0;
		}
	}
	sealed class Output : MemoryStream
	{
		int frames;
		public readonly TaskCompletionSource Replied = new(TaskCreationOptions.RunContinuationsAsynchronously);
		public override Task FlushAsync(CancellationToken cancellationToken)
		{
			if (Interlocked.Increment(ref frames) == 2)
				Replied.TrySetResult();
			return Task.CompletedTask;
		}
	}
	static byte[] Frame(object value)
	{
		var body = JsonSerializer.SerializeToUtf8Bytes(value);
		var bytes = new byte[body.Length + 4];
		BinaryPrimitives.WriteUInt32BigEndian(bytes, (uint)body.Length);
		body.CopyTo(bytes, 4);
		return bytes;
	}
	static JsonElement[] Read(Output output)
	{
		var bytes = output.ToArray();
		var frames = new List<JsonElement>();
		var offset = 0;
		while (offset < bytes.Length)
		{
			var size = (int)BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(offset, 4));
			using var document = JsonDocument.Parse(bytes.AsMemory(offset + 4, size));
			frames.Add(document.RootElement.Clone());
			offset += 4 + size;
		}
		return frames.ToArray();
	}
	public static async Task<int> Run()
	{
		var id = Guid.NewGuid().ToString();
		var frame = Frame(new
		{
			jsonrpc = "2.0",
			id,
			method = "fixture",
			@params = new
			{
			}
		});
		using var firstInput = new Input(frame);
		using var secondInput = new Input(frame);
		using var firstOutput = new Output();
		using var secondOutput = new Output();
		var both = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
		var started = 0;
		async Task<object?> Dispatch(string name, Func<object, Task> emit)
		{
			if (Interlocked.Increment(ref started) == 2)
				both.TrySetResult();
			await both.Task;
			await emit(new
			{
				type = "progress",
				operationId = id,
				percent = 100,
				message = name
			});
			return new
			{
				summary = name
			};
		}
		var first = new FramedBackendSession(firstInput, firstOutput, (_, _, emit, _) => Dispatch("first", emit)).RunAsync();
		var second = new FramedBackendSession(secondInput, secondOutput, (_, _, emit, _) => Dispatch("second", emit)).RunAsync();
		try
		{
			await Task.WhenAll(firstOutput.Replied.Task, secondOutput.Replied.Task).WaitAsync(TimeSpan.FromSeconds(5));
		}
		finally { firstInput.Closed.TrySetResult(); secondInput.Closed.TrySetResult(); }
		var exits = await Task.WhenAll(first, second);
		if (exits.Any(code => code != 0))
			throw new Exception("Independent session shutdown failed");
		foreach (var (output, name) in new[] { (firstOutput, "first"), (secondOutput, "second") })
		{
			var frames = Read(output);
			if (frames.Length != 2 || frames[0].GetProperty("params").GetProperty("message").GetString() != name ||
				frames[1].GetProperty("id").GetString() != id || frames[1].GetProperty("result").GetProperty("summary").GetString() != name)
				throw new Exception("Request IDs, progress or output escaped their owning session");
		}
		Console.WriteLine("Framed backend session isolation checks passed");
		return 0;
	}
}
