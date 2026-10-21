using MsgCommander.Application.Common;
using MsgCommander.Contracts.NotificationHubs.Registrations;

namespace MsgCommander.Application.NotificationHubs.Registrations;

public sealed class RegistrationSnapshotStore
{
	private readonly Queue<IReadOnlyList<NotificationHubRegistrationDetails>> pages = [];
	private readonly Dictionary<string, NotificationHubRegistrationDetails> editable = [];
	public NotificationHubRegistrationDetails Get(string? id) => editable.GetValueOrDefault(id ?? "") ?? pages.SelectMany(p => p).FirstOrDefault(i => i.Registration.SnapshotId == id) ?? throw new OperationException(OperationFailure.ConnectionExpired, "Registration snapshot expired. Query or reload it again.");
	public bool IsEditable(string id) => editable.ContainsKey(id);
	public static NotificationHubRegistrationDetails Freeze(NotificationHubRegistrationDetails value) => value with
	{
		Registration = value.Registration with
		{
			Tags = Array.AsReadOnly(value.Registration.Tags.ToArray())
		}
	};
	public void Remember(NotificationHubRegistrationDetails details)
	{
		editable[details.Registration.SnapshotId] = Freeze(details);
		while (editable.Count > 100)
			editable.Remove(editable.Keys.First());
	}

	public void RememberPage(IReadOnlyList<NotificationHubRegistrationDetails> values)
	{
		pages.Enqueue(Array.AsReadOnly(values.Select(Freeze).ToArray()));
		while (pages.Count > 2)
			pages.Dequeue();
	}

	public void Clear()
	{
		pages.Clear();
		editable.Clear();
	}
}
