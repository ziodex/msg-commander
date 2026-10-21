namespace MsgCommander.Application.NotificationHubs.Gateways;

public sealed class RegistrationRejectedException(string message) : Exception(message);
public sealed class NotificationSendRejectedException(string message) : Exception(message);
public sealed class NotificationHubJobRejectedException(string message) : Exception(message);
