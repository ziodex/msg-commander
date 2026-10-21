namespace MsgCommander.Application.Relay.Gateways;

public sealed record RelayFailure(bool Rejected, bool Denied, bool NotFound);
public interface IRelayFailureClassifier
{
	RelayFailure Classify(Exception error);
}
