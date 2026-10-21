namespace MsgCommander.Application.ServiceBus.Maintenance;

public enum MaintenanceOperation
{
	Purge, ReceiveDelete, Resend, CrossNamespaceResend
}
public sealed record MaintenanceFailure(bool IsRejected, bool IsTimeout, string? SafeDetail);
public interface IMaintenanceFailureClassifier
{
	MaintenanceFailure Classify(Exception error, MaintenanceOperation operation);
}
