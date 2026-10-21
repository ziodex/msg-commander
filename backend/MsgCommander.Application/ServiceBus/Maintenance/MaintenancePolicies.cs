using MsgCommander.Application.Common;
using MsgCommander.Contracts.ServiceBus.Maintenance;
using MsgCommander.Domain.Common;
using MsgCommander.Domain.ServiceBus.Messages;

namespace MsgCommander.Application.ServiceBus.Maintenance;

internal static class MaintenancePolicies
{
	public static DateTimeOffset? ParseCutoff(PurgeCutoffInput input)
	{
		if (!input.Supplied)
			return null;
		try
		{
			return PurgeCutoff.Parse(input.UtcValue);
		}
		catch (DomainRuleException error) { throw new OperationException(OperationFailure.InvalidInput, error.Message); }
	}
	public static string? CutoffText(DateTimeOffset? value) => value is null ? null : PurgeCutoff.Format(value.Value);
	public static void ValidateSubQueue(string value)
	{
		if (value is not ("active" or "dead-letter" or "transfer-dead-letter"))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid message subqueue.");
	}
}
