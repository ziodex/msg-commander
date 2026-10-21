using MsgCommander.Application.Connections;
using MsgCommander.Domain.Connections;

static class ConnectionLifetimeChecks
{
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	static TaskCompletionSource Barrier() => new(TaskCreationOptions.RunContinuationsAsynchronously);
	sealed record Connection(string Id, string Name);
	sealed class Client(string name, List<string> events) : IAsyncDisposable
	{
		public int Disposals;
		public ValueTask DisposeAsync()
		{
			Disposals++;
			events.Add($"dispose:{name}");
			return ValueTask.CompletedTask;
		}
	}

	public static async Task<int> Run()
	{
		var events = new List<string>();
		var clearCount = 0;
		var failClear = false;
		await using var scope = new ConnectionScope<Client, Connection>(() =>
		{
			clearCount++;
			events.Add("clear");
			return failClear ? ValueTask.FromException(new IOException("cleanup")) : ValueTask.CompletedTask;
		}, connection => connection.Id, "Connection expired.");
		var first = new Client("first", events);
		var a = await scope.ConnectAsync(_ => Task.FromResult(first), (id, _) => new(id, "first"), default);
		Assert(Guid.TryParse(a.Id, out _) && scope.Client == first, "Publish a fresh owned client and connection identity");
		var resetBeforeWrongDisconnect = clearCount;
		await scope.DisconnectAsync(Guid.NewGuid().ToString(), default);
		Assert(scope.Connection == a && clearCount == resetBeforeWrongDisconnect && first.Disposals == 0, "A stale disconnect cannot close a newer connection");
		var entered = Barrier();
		var finish = Barrier();
		var operation = scope.ExecuteAsync(a.Id, async (client, _) =>
		{
			Assert(client == first, "Operation uses its owned client");
			entered.SetResult();
			await finish.Task;
			return 42;
		}, default);
		await entered.Task;
		var replacementStarted = false;
		var second = new Client("second", events);
		var replacement = scope.ConnectAsync(_ =>
		{
			replacementStarted = true;
			Assert(first.Disposals == 1 && events[^1] == "dispose:first" && events[^2] == "clear", "Reset dependents and dispose the old client before authenticating its replacement");
			return Task.FromResult(second);
		}, (id, _) => new(id, "second"), default);
		Assert(!replacementStarted && first.Disposals == 0, "Replacement waits for the current operation");
		finish.SetResult();
		Assert(await operation == 42, "Preserve the operation result before disposing its client");
		var b = await replacement;
		Assert(b.Id != a.Id && first.Disposals == 1 && scope.Client == second, "Replace the client once with a new generation");
		try
		{
			await scope.ExecuteAsync(a.Id, (_, _) => Task.FromResult(0), default);
			throw new Exception("Expected stale connection rejection");
		}
		catch (ConnectionExpiredException) { }
		using var cancelled = new CancellationTokenSource();
		var late = new Client("late", events);
		try
		{
			await scope.ConnectAsync(_ => { cancelled.Cancel(); return Task.FromResult(late); }, (id, _) => new(id, "late"), cancelled.Token);
			throw new Exception("Expected cancelled candidate rejection");
		}
		catch (OperationCanceledException) { }
		Assert(second.Disposals == 1 && late.Disposals == 1 && scope.Client is null && scope.Connection is null, "Dispose cancelled candidates without keeping stale credentials");
		var third = new Client("third", events);
		await scope.ConnectAsync(_ => Task.FromResult(third), (id, _) => new(id, "third"), default);
		failClear = true;
		try
		{
			await scope.ResetAsync(default);
			throw new Exception("Expected reset error");
		}
		catch (IOException) { }
		Assert(third.Disposals == 1 && scope.Client is null && scope.Connection is null, "A dependent cleanup error cannot retain the client or credentials");
		failClear = false;
		await scope.DisposeAsync();
		await scope.DisposeAsync();
		Assert(!default(ConnectionIdentity).Matches(null), "An uninitialized identity cannot identify a connection");
		var identity = ConnectionIdentity.Create();
		Assert(identity.Matches(identity.Value) && !identity.Matches(Guid.NewGuid().ToString()), "Connection identities match only their exact generation");
		await Receivers(events);
		Console.WriteLine("Connection lifetime checks passed");
		return 0;
	}

	static async Task Receivers(List<string> events)
	{
		var resets = 0;
		await using var owner = new ReceiverOwner<Client, string>(() => resets++);
		var first = new Client("receiver", events);
		await owner.OpenAsync(new("orders", "active", "session"), _ => Task.FromResult(first), default);
		var id = owner.OwnershipId;
		Assert(owner.Address?.Target == "orders" && id is not null, "Receiver metadata belongs to its owned client");
		try
		{
			await owner.OpenAsync(new("other", "active", null), _ => throw new Exception("Must not open"), default);
			throw new Exception("Expected ownership rejection");
		}
		catch (InvalidOperationException) { }
		await owner.DisposeAsync();
		Assert(first.Disposals == 1 && owner.Current is null && owner.Address is null && owner.OwnershipId is null && resets == 1, "Clear receiver state before releasing its lease");
		using var cancellation = new CancellationTokenSource();
		var late = new Client("cancelled-receiver", events);
		try
		{
			await owner.OpenAsync(new("orders", "active", null), _ => { cancellation.Cancel(); return Task.FromResult(late); }, cancellation.Token);
			throw new Exception("Expected receiver cancellation");
		}
		catch (OperationCanceledException) { }
		Assert(late.Disposals == 1 && owner.Current is null, "Cancelled receiver acquisition cannot leave a live lease");
		var again = new Client("next-receiver", events);
		await owner.OpenAsync(new("orders", "active", null), _ => Task.FromResult(again), default);
		Assert(owner.OwnershipId != id, "Reopened receivers get fresh ownership identities");
	}
}
