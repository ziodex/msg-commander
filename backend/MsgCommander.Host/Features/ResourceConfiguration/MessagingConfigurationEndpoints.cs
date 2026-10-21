using System.Security.Cryptography;
using System.Text.Json;

namespace MsgCommander.Host;

public static class MessagingConfigurationEndpoints
{
	public static async Task<object?> Execute(MessagingConfigurationService service, string method, JsonElement input, Func<object, Task> emit, CancellationToken cancellation)
	{
		var requestedService = input.GetProperty("service").GetString()!;
		if (requestedService != service.Service)
			throw MessagingConfiguration.Invalid();
		switch (method)
		{
			case "result":
				return service.GetResult(requestedService, input.GetProperty("operationId").GetString()!);
			case "discard":
				service.Discard(requestedService);
				return null;
			case "export":
				return await service.ExportAsync(new(requestedService,
				input.GetProperty("scope").Deserialize<MessagingConfigTarget?>(MessagingConfiguration.Json),
				input.GetProperty("format").GetString()!, input.GetProperty("includePolicies").GetBoolean()), cancellation);
			case "preview":
				return await service.PreviewAsync(new(requestedService, input.GetProperty("contentBase64").GetString()!), cancellation);
			case "apply":
				var request = input.Deserialize<MessagingConfigApply>(MessagingConfiguration.Json)!;
				var fingerprint = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(input, MessagingConfiguration.Json)));
				return await service.ApplyAsync(request, fingerprint, progress => emit(progress), cancellation);
			default:
				throw MessagingConfiguration.Invalid();
		}
	}
}
