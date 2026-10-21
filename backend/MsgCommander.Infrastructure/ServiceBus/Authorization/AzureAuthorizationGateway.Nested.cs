using System.Text.Json;
using Azure;
using Azure.Core;
using Azure.Core.Pipeline;
using Azure.ResourceManager;

namespace MsgCommander.Infrastructure.ServiceBus;

public sealed partial class AzureAuthorizationGateway
{
	private sealed class ArmTransport(ArmClient client, string id) : ArmResource(client, new ResourceIdentifier(id))
	{
		public HttpPipeline RequestPipeline => Pipeline;
		public Uri RequestEndpoint => Endpoint;
	}
	private readonly ArmTransport transport = new(client, resourceId);
	// ResourceIdentifier treats a slash in an entity name as another resource level.
	// Use the same authenticated, zero-retry ARM pipeline with one escaped name segment.
	private static bool Nested(AuthorizationTarget target) => target.Name?.Contains('/') == true;
	private Uri NestedUri(AuthorizationTarget target, string? name, string? operation)
	{
		target.Validate();
		if (name is not null)
			AccessPolicyRules.ValidateName(name);
		return new(transport.RequestEndpoint, $"{resourceId}/{(target.Kind == "queue" ? "queues" : "topics")}/{Uri.EscapeDataString(target.Name!)}/authorizationRules{(name is null ? "" : "/" + Uri.EscapeDataString(name))}{(operation is null ? "" : "/" + operation)}?api-version=2026-01-01");
	}
	private async Task<JsonElement> SendNestedAsync(AuthorizationTarget target, string? name, string? operation, RequestMethod method, object? body, CancellationToken cancellation, Uri? page = null)
	{
		var endpoint = NestedUri(target, name, operation);
		var uri = page ?? endpoint;
		if (uri.Scheme != endpoint.Scheme || uri.Authority != endpoint.Authority || !uri.AbsolutePath.Equals(endpoint.AbsolutePath, StringComparison.OrdinalIgnoreCase))
			throw new OperationException(OperationFailure.InspectionLimit, "ARM pagination returned an unexpected scope.");
		using var message = transport.RequestPipeline.CreateMessage();
		message.Request.Method = method;
		message.Request.Uri.Reset(uri);
		message.Request.Headers.SetValue("Accept", "application/json");
		if (body is not null)
		{
			message.Request.Headers.SetValue("Content-Type", "application/json");
			message.Request.Content = RequestContent.Create(BinaryData.FromObjectAsJson(body));
		}
		await transport.RequestPipeline.SendAsync(message, cancellation);
		var response = message.Response;
		if (response.Status >= 400)
			throw new RequestFailedException(response.Status, "Azure Resource Manager rejected the SAS request.");
		if (response.Status == 204)
			return default;
		if (response.Status is not (200 or 201))
			throw new IOException("ARM did not confirm the SAS operation.");
		if (method == RequestMethod.Delete)
			return default;
		using var json = await JsonDocument.ParseAsync(response.ContentStream!, cancellationToken: cancellation);
		return json.RootElement.Clone();
	}
	private AuthorizationRule ProjectNested(AuthorizationTarget target, JsonElement data) => AccessPolicyRules.Project(Scope(target),
		data.GetProperty("name").GetString()!, data.GetProperty("properties").GetProperty("rights").EnumerateArray().Select(r => r.GetString()!).ToArray());
	private async Task<AuthorizationPage> ListNestedAsync(AuthorizationTarget target, CancellationToken cancellation)
	{
		List<AuthorizationRule> items = [];
		Uri? page = null;
		for (var count = 0; count < 100; count++)
		{
			var data = await SendNestedAsync(target, null, null, RequestMethod.Get, null, cancellation, page);
			foreach (var rule in data.GetProperty("value").EnumerateArray())
			{
				if (items.Count >= 100)
					throw new OperationException(OperationFailure.InspectionLimit, "SAS rule list exceeds the 100-rule local limit.");
				items.Add(ProjectNested(target, rule));
			}
			if (!data.TryGetProperty("nextLink", out var next) || string.IsNullOrEmpty(next.GetString()))
				return new(items);
			page = new Uri(next.GetString()!, UriKind.Absolute);
		}
		throw new OperationException(OperationFailure.InspectionLimit, "SAS rule paging exceeds the local limit.");
	}
}
