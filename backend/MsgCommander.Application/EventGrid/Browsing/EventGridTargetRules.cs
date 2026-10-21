using System.Text.RegularExpressions;
using MsgCommander.Application.Common;
using MsgCommander.Contracts.EventGrid.Browsing;
using MsgCommander.Domain.EventGrid;

namespace MsgCommander.Application.EventGrid.Browsing;

public static class EventGridTargetRules
{

	internal const string ResourcePattern = @"^/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[A-Za-z0-9_().-]{1,90}/providers/Microsoft\.EventGrid/namespaces/[A-Za-z0-9-]{3,50}$";
	public static void Validate(this EventGridManagement value, string host)
	{
		var (ResourceId, TenantId, ClientId) = value;
		if (ResourceId is null || !Regex.IsMatch(ResourceId, ResourcePattern, RegexOptions.IgnoreCase) || !Guid.TryParse(ResourceId.Split('/')[2], out _) || ResourceId.Split('/').Any(v => v is "." or "..") || !Regex.IsMatch(host ?? "", @"^[a-z0-9-]{3,50}\.[a-z0-9-]+\.eventgrid\.azure\.net$", RegexOptions.IgnoreCase) || !string.Equals(host!.Split('.')[0], ResourceId.Split('/')[^1], StringComparison.OrdinalIgnoreCase) || TenantId is null || !Regex.IsMatch(TenantId, @"^[A-Za-z0-9.-]{1,100}$") || !Guid.TryParse(ClientId, out _))
			throw new OperationException(OperationFailure.InvalidInput, "Use a matching Event Grid namespace resource ID, HTTP topics hostname, tenant and public client application ID.");
	}

	public static void Validate(this EventGridTarget target) => Address(target);
	private static EventGridAddress Address(EventGridTarget target)
	{
		try
		{
			return EventGridAddress.Create(target.Kind, target.TopicName, target.SubscriptionName);
		}
		catch (MsgCommander.Domain.Common.DomainRuleException error) { throw new OperationException(OperationFailure.InvalidInput, error.Message); }
	}
	public static string Suffix(this EventGridTarget target) => Address(target).Suffix;
}
