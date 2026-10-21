using MsgCommander.Application.Common;
using MsgCommander.Contracts.ServiceBus.Messages;

namespace MsgCommander.Application.ServiceBus.Messages;

public static class MessageDraftValidation
{
	public static void Validate(IReadOnlyList<MessageDraft> drafts)
	{
		if (drafts.Count is < 1 or > 20)
			throw new OperationException(OperationFailure.InvalidInput, "Use 1–20 drafts and at most 512 KiB of serialized drafts.");
		foreach (var draft in drafts)
			OutgoingMessages.Build(draft);
	}
}
