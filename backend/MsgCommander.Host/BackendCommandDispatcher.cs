using System.Collections.Frozen;
using System.Runtime.InteropServices;
using System.Text.Json;
using MsgCommander.Application.ServiceBus.Connections;

namespace MsgCommander.Host;

internal sealed class BackendCommandDispatcher(ServiceBusWorkspace serviceBus, EventHubsWorkspace eventHubs, RelayWorkspace relay, NotificationHubWorkspace notificationHubs, NotificationHubRegistrationsWorkspace registrations, NotificationHubNotificationsWorkspace notifications, EventGridWorkspace eventGrid, HybridWorkspace hybrid, IServiceBusAuthenticationProbe authentication, IProviderFailureMapper failures)
{
	private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
	// These operations own their acknowledgement or recoverable state; late cancellation cannot replace it.
	private static readonly FrozenSet<string> RetainedResults = new[]
	{
		"eg.pull.receive",
		"eg.pull.settle",
		"eg.publish",
		"eg.admin.change",
		"nh.credentials.change",
		"nh.notifications.send",
		"nh.registrations.change",
		"nh.registrations.files.apply",
		"nh.registrations.jobs.submit",
		"nh.change",
		"hybrid.run",
		"relay.config.apply",
		"sb.config.apply",
		"eh.config.apply",
		"nh.config.apply",
		"relay.change",
		"eh.listen",
		"eh.admin.change",
		"eh.send",
		"eh.read",
		"sb.test.run",
		"sb.receive-delete",
		"sb.listener.start",
		"sb.listener.stop",
		"sb.listener.settle",
		"sb.entity.copy.execute",
		"sb.entity.rename.finish",
		"sb.authorization.create",
		"sb.authorization.update",
		"sb.authorization.delete",
		"sb.authorization.regenerate",
		"sb.purge",
		"sb.entity.bulk.execute",
		"sb.purge.bulk",
		"sb.deadletters.resend",
		"sb.session.accept",
		"sb.session.state.set",
		"sb.session.renew",
		"sb.send.batch",
		"sb.scheduled.cancel",
		"sb.snapshot.resend",
		"sb.send",
		"sb.settle",
		"sb.replay",
		"sb.receive",
		"sb.entity.create",
		"sb.entity.update",
		"sb.entity.delete",
		"sb.rule.create",
		"sb.rule.update",
		"sb.rule.delete",
	}.ToFrozenSet(StringComparer.Ordinal);
	public async Task<object?> ExecuteAsync(string? method, JsonElement parameters, Func<object, Task> emit, CancellationToken cancellation)
	{
		try
		{
			return await DispatchAsync(method, parameters, emit, cancellation);
		}
		catch (Exception error) when (error is not (OperationException or OperationCanceledException))
		{
			if (failures.Map(error, method) is { } mapped)
				throw mapped;
			throw;
		}
	}

	private async Task<object?> DispatchAsync(string? method, JsonElement parameters, Func<object, Task> emit, CancellationToken cancellation)
	{
		object? result = method switch
		{
			not null when method.StartsWith("sb.", StringComparison.Ordinal) => await serviceBus.ExecuteAsync(method, parameters, emit, cancellation),
			not null when method.StartsWith("eh.", StringComparison.Ordinal) => await eventHubs.ExecuteAsync(method, parameters, emit, cancellation),
			not null when method.StartsWith("nh.notifications.", StringComparison.Ordinal) => await notifications.ExecuteAsync(method, parameters, cancellation),
			not null when method.StartsWith("nh.registrations.", StringComparison.Ordinal) => await registrations.ExecuteAsync(method, parameters, cancellation, emit),
			not null when method.StartsWith("nh.", StringComparison.Ordinal) => await notificationHubs.ExecuteAsync(method, parameters, emit, cancellation),
			not null when method.StartsWith("relay.", StringComparison.Ordinal) => await relay.ExecuteAsync(method, parameters, emit, cancellation),
			not null when method.StartsWith("hybrid.", StringComparison.Ordinal) => await hybrid.ExecuteAsync(method, parameters, emit, cancellation),
			not null when method.StartsWith("eg.", StringComparison.Ordinal) => await eventGrid.ExecuteAsync(method, parameters, emit, cancellation),
			"messages.validate" => ValidateDrafts(parameters),
			"body.codec" => BodyCodecs.ConvertBody(parameters, cancellation),
			"test.payload.preview" => TestPayloads.Preview(parameters, cancellation),
			"host.hello" => Hello(parameters),
			"diagnostics.run" => await Diagnostics(parameters, emit, cancellation),
			"auth.test" => await TestAuthentication(parameters, emit, cancellation),
			_ => throw new OperationException(OperationFailure.UnknownOperation, "Unknown method.")
		};
		// A write acknowledged before cancellation must retain its truthful receipt; receive handles remain recoverable.
		if (method is null || !RetainedResults.Contains(method))
			cancellation.ThrowIfCancellationRequested();
		return result;
	}

	private static object? ValidateDrafts(JsonElement parameters)
	{
		var values = parameters.GetProperty("drafts");
		if (values.GetArrayLength() is < 1 or > 20 || System.Text.Encoding.UTF8.GetByteCount(values.GetRawText()) > 524288)
			throw new OperationException(OperationFailure.InvalidInput, "Use 1–20 drafts and at most 512 KiB of serialized drafts.");
		MessageDraftValidation.Validate(values.Deserialize<MessageDraft[]>(Json)!);
		return null;
	}

	private static object Hello(JsonElement parameters)
	{
		if (parameters.GetProperty("protocolVersion").GetInt32() != 1)
			throw new OperationException(OperationFailure.UnsupportedProtocol, "Unsupported protocol version.");
		return new
		{
			protocolVersion = 1,
			runtime = $".NET {Environment.Version} · {RuntimeInformation.ProcessArchitecture}",
			version = "0.63.0"
		};
	}

	private static async Task<object> Diagnostics(JsonElement parameters, Func<object, Task> emit, CancellationToken cancellation)
	{
		var operationId = OperationId(parameters);
		var duration = parameters.GetProperty("durationMs").GetInt32();
		return await MsgCommander.Application.Diagnostics.LocalDiagnosticsService.RunAsync(operationId, duration, progress => emit(progress), cancellation);
	}

	private async Task<object> TestAuthentication(JsonElement parameters, Func<object, Task> emit, CancellationToken cancellation)
	{
		var operationId = OperationId(parameters);
		var profile = parameters.GetProperty("profile").Deserialize<ConnectionProfile>(Json) ?? throw new OperationException(OperationFailure.InvalidInput, "Missing profile.");
		return await authentication.CheckAsync(profile, code => emit(new { type = "device-code", operationId, code = code.Code, expiresOn = code.ExpiresOn }), cancellation);
	}

	private static string OperationId(JsonElement parameters)
	{
		var id = parameters.GetProperty("operationId").GetString();
		if (!Guid.TryParse(id, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Invalid operation ID.");
		return id!;
	}
}
