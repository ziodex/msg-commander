namespace MsgCommander.Contracts.NotificationHubs.Notifications;

public sealed record NotificationParameter(string Name, string Value);
public sealed record NotificationHeader(string Name, string Value);
public sealed record NotificationDraft(string Format, string Target, string TagExpression, string Body, IReadOnlyList<NotificationParameter> Parameters, IReadOnlyList<NotificationHeader> Headers);
public sealed record NotificationTestSend(string Id, string ConnectionId, NotificationDraft Draft, bool Acknowledge);
public sealed record NotificationDeviceResult(string Platform, string PnsHandle, string RegistrationId, string Outcome);
public sealed record NotificationSendDetails(int? Success, int? Failure, IReadOnlyList<NotificationDeviceResult> Results, string TrackingId, string? NotificationId, string? RawXml, string? Warning);
public sealed record NotificationSendOutcome(string OperationId, string Status, string Summary, string CapturedAt, NotificationDraft Draft, NotificationSendDetails? Details);
