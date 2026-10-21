using MsgCommander.Host;
using Azure.Messaging.EventHubs.Consumer;
static class IotHubAdapterChecks
{
	static void Assert(bool condition, string label)
	{
		if (!condition)
			throw new Exception(label);
	}
	public static async Task<int> Run()
	{
		var host = "iothub-ns-" + new string('a', 50);
		var secret = $"Endpoint=sb://{host}.servicebus.windows.net/;SharedAccessKeyName=service;SharedAccessKey=ZmFrZQ==;EntityPath=iothub-ehub-fixture-123";
		var profile = new ConnectionProfile(Guid.NewGuid().ToString(), "IoT", "iot-hub", host + ".servicebus.windows.net", "sas", "", "", secret);
		var endpoint = IotHubEndpoint.Validate(profile);
		Assert(endpoint.HubName == "iothub-ehub-fixture-123" && endpoint.Namespace == profile.Namespace, "Long compatible endpoint label and EntityPath accepted");
		await using var gateway = await new AzureEventHubsGatewayFactory().ConnectAsync(profile, null, _ => Task.CompletedTask, default);
		Assert(!gateway.CanBrowse && gateway.Administration is null, "IoT has no Event Hubs ARM administration");
		await using (var reader = gateway.OpenReader(endpoint.HubName, "audit", "0", StreamPosition.Create("earliest")))
		{
		}
		try
		{
			gateway.OpenSender(endpoint.HubName);
			throw new Exception("Producer accepted");
		}
		catch (OperationException) { }
		try
		{
			gateway.OpenReader("other", "audit", "0", StreamPosition.Create("earliest"));
			throw new Exception("Wrong hub accepted");
		}
		catch (OperationException) { }
		try
		{
			await gateway.GetHubAsync(endpoint.HubName, default, true);
			throw new Exception("Producer metadata accepted");
		}
		catch (OperationException) { }
		try
		{
			await new AzureEventHubsGatewayFactory().ConnectAsync(profile, new("invalid", "tenant", Guid.NewGuid().ToString()), _ => Task.CompletedTask, default);
			throw new Exception("ARM accepted");
		}
		catch (OperationException) { }
		foreach (var invalid in new[] { secret + ";DeviceId=device", secret + ";EntityPath=other", secret.Replace("EntityPath=", "Missing="), secret.Replace("sb://", "https://"), secret.Replace(".windows.net/", ".windows.net.evil/"), secret.Replace("ZmFrZQ==", "not-base64"), secret + ";;" })
		{
			try
			{
				IotHubEndpoint.Parse(invalid);
				throw new Exception("Invalid endpoint accepted");
			}
			catch (OperationException e) { Assert(!e.Message.Contains("ZmFrZQ"), "No secret echoed"); }
		}
		foreach (var invalid in new[] { profile with { Auth = "device-code" }, profile with { Namespace = "wrong.servicebus.windows.net" } })
		{
			try
			{
				IotHubEndpoint.Validate(invalid);
				throw new Exception("Invalid profile accepted");
			}
			catch (OperationException) { }
		}
		Assert(AzureEventHubsGateway.ReaderOptions().OwnerLevel is null && AzureEventHubsGateway.ReaderOptions().RetryOptions.MaximumRetries == 0, "Non-exclusive, no automatic retries");
		Console.WriteLine("IoT Hub endpoint adapter checks passed");
		return 0;
	}
}
