using System.Text.RegularExpressions;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.NotificationHubs;

public static class RegistrationQueryRules
{
	public static void Validate(string mode, string filterValue, string handleKind, int pageSize)
	{
		var valid = filterValue is not null && filterValue.Length <= 4096 && !filterValue.Any(char.IsControl) && pageSize is >= 1 and <= 100 && handleKind is "any" or "apns" or "wns" or "fcm";
		if (mode == "all")
			valid = valid && filterValue == "" && handleKind == "any";
		else if (mode == "tag")
			valid = valid && handleKind == "any" && Regex.IsMatch(filterValue ?? "", @"^[A-Za-z0-9_@#.:~-]{1,120}$") && filterValue is not ("." or "..");
		else if (mode == "handle")
		{
			valid = valid && !string.IsNullOrWhiteSpace(filterValue);
			if (handleKind == "apns")
				valid = valid && Regex.IsMatch(filterValue ?? "", @"^(?:[A-Fa-f0-9]{2}){1,256}$");
			if (handleKind == "fcm")
				valid = valid && !filterValue!.Any(char.IsWhiteSpace);
			if (handleKind == "wns")
				valid = valid && Uri.TryCreate(filterValue, UriKind.Absolute, out var uri) && uri.Scheme == "https" && uri.Host != "" && uri.UserInfo == "" && uri.Fragment == "";
		}
		else
			valid = false;
		if (!valid)
			throw new DomainRuleException("Use one exact tag, a valid APNS hex token, a WNS HTTPS handle or a non-empty device handle; page size must be 1–100.");
	}
}
