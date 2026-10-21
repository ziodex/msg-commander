namespace MsgCommander.Application.ResourceConfiguration;

public sealed record ConfigurationFailure(bool IsNotFound = false, bool IsRejected = false);

public interface IConfigurationFailureClassifier
{
	ConfigurationFailure Classify(Exception error);
}
