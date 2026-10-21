namespace MsgCommander.Application.Common;

public interface IProviderFailureMapper
{
	OperationException? Map(Exception failure, string? operation);
}
