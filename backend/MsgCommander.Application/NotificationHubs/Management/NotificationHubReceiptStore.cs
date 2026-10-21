using MsgCommander.Application.Common;
using MsgCommander.Contracts.NotificationHubs.Management;

namespace MsgCommander.Application.NotificationHubs.Management;

/// <summary>Management and provider changes share the same bounded ID/fingerprint namespace.</summary>
public sealed class NotificationHubReceiptStore
{
	private readonly Dictionary<string, (string Stamp, NotificationHubOutcome Result)> outcomes = [];
	public NotificationHubOutcome? Get(string id) => outcomes.TryGetValue(id, out var saved) ? saved.Result : null;
	public NotificationHubOutcome? Check(string id, string stamp)
	{
		if (outcomes.TryGetValue(id, out var saved))
		{
			if (saved.Stamp != stamp)
				throw new OperationException(OperationFailure.InvalidInput, "Notification Hubs operation ID belongs to another request.");
			return saved.Result;
		}
		if (outcomes.Count >= 100)
			throw new OperationException(OperationFailure.OperationBlocked, "Notification Hubs receipt limit reached. Review results before reconnecting.");
		return null;
	}
	public void Add(string id, string stamp, NotificationHubOutcome result) => outcomes.Add(id, (stamp, result));
	public void Clear() => outcomes.Clear();
}
