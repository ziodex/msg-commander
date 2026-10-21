using MsgCommander.Domain.Common;

namespace MsgCommander.Application.Common;

public static class DomainValidation
{
	public static T Read<T>(Func<T> read)
	{
		try
		{
			return read();
		}
		catch (DomainRuleException error) { throw new OperationException(OperationFailure.InvalidInput, error.Message); }
	}

	public static void Check(Action check)
	{
		try
		{
			check();
		}
		catch (DomainRuleException error) { throw new OperationException(OperationFailure.InvalidInput, error.Message); }
	}
}
