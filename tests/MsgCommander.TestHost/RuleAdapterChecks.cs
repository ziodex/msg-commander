using System.Net;
using System.Xml.Linq;
using Azure.Core.Pipeline;
using Azure.Messaging.ServiceBus;
using Azure.Messaging.ServiceBus.Administration;
using MsgCommander.Host;

static class RuleAdapterChecks
{
	static void Assert(bool value, string message)
	{
		if (!value)
			throw new Exception(message);
	}
	public static async Task<int> Run()
	{
		const string connection = "Endpoint=sb://fixture.servicebus.windows.net/;SharedAccessKeyName=Fixture;SharedAccessKey=ZmFrZQ==";
		using var wire = new Wire();
		using var http = new HttpClient(wire);
		var admin = new ServiceBusAdministrationClient(connection, new ServiceBusAdministrationClientOptions { Transport = new HttpClientTransport(http), Retry = { MaxRetries = 0 } });
		await using var gateway = new AzureServiceBusGateway(admin, new ServiceBusClient(connection));
		var target = new EntityTarget("subscription", "billing", "events");
		var dispatches = 0;
		var sql = new RuleDefinition("sql", "user.total > @minimum", [new("@minimum", "int64", "9007199254740993")], null, "SET user.route = @route; REMOVE user.secret;", [new("@route", "string", "Málaga 🚀")]);
		await gateway.ChangeRuleAsync("create", target, "sql-rule", sql, null, () => dispatches++, default);
		var first = await gateway.GetRuleAsync(target, "sql-rule", default);
		Assert(first.ReadOnlyReason is null, "Known SQL rule is editable");
		Assert(first.Definition.FilterParameters.Single().Value == "9007199254740993", "Int64 never passes through a JS number");
		var sdkRule = (await admin.GetRuleAsync("events", "billing", "sql-rule")).Value;
		Assert(((SqlRuleFilter)sdkRule.Filter).Parameters["@minimum"] is long l && l == 9007199254740993, "Actual XML retains Int64 type");
		Assert(((SqlRuleAction)sdkRule.Action).Parameters["@route"] is string s && s == "Málaga 🚀", "SQL action and Unicode parameter round trip");
		var correlation = new CorrelationSettings("order-id", "message-id", "blue", "application/json", "destination", "reply", "session", "reply-session", [new("count", "int32", "7"), new("enabled", "boolean", "true"), new("ratio", "double", "1.25"), new("created", "datetime", "2026-10-10T12:00:00Z"), new("duration", "timespan", "00:05:00"), new("empty", "string", "")]);
		var changed = sql with
		{
			FilterType = "correlation",
			SqlExpression = "",
			FilterParameters = [],
			Correlation = correlation
		};
		await gateway.ChangeRuleAsync("update", target, "sql-rule", changed, first.Revision, () => dispatches++, default);
		var current = await gateway.GetRuleAsync(target, "sql-rule", default);
		Assert(current.ReadOnlyReason is null && current.Definition.Correlation!.Subject == "blue", "Correlation headers round trip including legacy Label XML");
		sdkRule = (await admin.GetRuleAsync("events", "billing", "sql-rule")).Value;
		var filter = (CorrelationRuleFilter)sdkRule.Filter;
		Assert(filter.ApplicationProperties["duration"] is TimeSpan && filter.ApplicationProperties["created"] is DateTime && filter.ApplicationProperties["enabled"] is bool && filter.ApplicationProperties["count"] is int, "Correlation HTTP-supported types preserved");
		Assert(wire.LastIfMatch == "*", "Rule updates use wildcard If-Match; revision check is best effort");
		var puts = wire.Puts;
		try
		{
			await gateway.ChangeRuleAsync("delete", target, "sql-rule", null, first.Revision, () => dispatches++, default);
			throw new Exception("Stale delete accepted");
		}
		catch (OperationException e) { Assert(e.Failure == OperationFailure.RevisionConflict, "Stale revision rejected"); }
		Assert(wire.Puts == puts && wire.Deletes == 0, "Stale change makes no mutating HTTP request");
		await gateway.ChangeRuleAsync("update", target, "sql-rule", current.Definition with
		{
			ActionExpression = "",
			ActionParameters = []
		}, current.Revision, () => dispatches++, default);
		Assert((await admin.GetRuleAsync("events", "billing", "sql-rule")).Value.Action is null, "Clearing action removes it without replacing/deleting the rule");
		foreach (var (name, kind) in new[] { ("$Default", "true"), ("none", "false") })
			await gateway.ChangeRuleAsync("create", target, name, new(kind, "", [], null, "", []), null, () => dispatches++, default);
		var page = await gateway.ListRulesAsync(target, null, default);
		Assert(page.Items.Any(r => r.Name == "$Default" && r.FilterType == "true"), "List retains match-all type and default name");
		Assert(wire.Paths.All(p => p.StartsWith("events/Subscriptions/billing/Rules", StringComparison.OrdinalIgnoreCase)), "All operations stay scoped to the subscription rule endpoint");
		var doc = wire.Entities[SubscriptionRules.Path(target, "sql-rule")];
		var valueElement = doc.Descendants().First(e => e.Name.LocalName == "Value");
		XNamespace xsi = "http://www.w3.org/2001/XMLSchema-instance";
		valueElement.SetAttributeValue(xsi + "type", "l28:decimal"); // SDK would coerce this to string.
		current = await gateway.GetRuleAsync(target, "sql-rule", default);
		Assert(current.ReadOnlyReason is not null, "Unsupported raw XML type cannot be silently coerced on edit");
		Assert(current.Definition.FilterType == "unsupported", "Coerced values are not presented as faithful editable data");
		puts = wire.Puts;
		try
		{
			await gateway.ChangeRuleAsync("update", target, "sql-rule", changed, current.Revision, () => dispatches++, default);
			throw new Exception("Unsupported edit accepted");
		}
		catch (OperationException) { }
		Assert(wire.Puts == puts, "Read-only rule never dispatches update");
		await gateway.ChangeRuleAsync("delete", target, "sql-rule", null, current.Revision, () => dispatches++, default);
		Assert(wire.Entities.ContainsKey(SubscriptionRules.Path(target, "$Default")) && wire.Deletes == 1, "Delete affects only explicitly named rule");
		Assert(dispatches == 6, "Exactly six acknowledged dispatches; no replacement delete/create on edits");
		Console.WriteLine("Rule adapter checks passed");
		return 0;
	}
	sealed class Wire : HttpMessageHandler
	{
		public Dictionary<string, XDocument> Entities = new(StringComparer.OrdinalIgnoreCase);
		public List<string> Paths = [];
		public int Puts, Deletes;
		public string? LastIfMatch;
		protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
		{
			var path = Uri.UnescapeDataString(request.RequestUri!.AbsolutePath.Trim('/'));
			Paths.Add(path);
			XNamespace atom = "http://www.w3.org/2005/Atom";
			if (request.Method == HttpMethod.Put)
			{
				Puts++;
				LastIfMatch = request.Headers.IfMatch.FirstOrDefault()?.Tag;
				var doc = XDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
				doc.Root!.AddFirst(new XElement(atom + "title", path.Split('/').Last()));
				Entities[path] = doc;
			}
			if (request.Method == HttpMethod.Delete)
			{
				Deletes++;
				Entities.Remove(path);
				return new(HttpStatusCode.OK);
			}
			if (path.EndsWith("/Rules", StringComparison.OrdinalIgnoreCase))
				return Xml(new XDocument(new XElement(atom + "feed", Entities.Where(p => p.Key.StartsWith(path + "/", StringComparison.OrdinalIgnoreCase)).Select(p => new XElement(p.Value.Root!)))));
			return Entities.TryGetValue(path, out var value) ? Xml(value) : new(HttpStatusCode.NotFound)
			{
				Content = new StringContent("Missing fixture")
			};
		}
		static HttpResponseMessage Xml(XDocument value)
		{
			var copy = new XDocument(value);
			XNamespace xsi = "http://www.w3.org/2001/XMLSchema-instance";
			// Known service-managed metadata is absent from SDK serialization but may be returned by Azure.
			foreach (var part in copy.Descendants().Where(e => (string?)e.Attribute(xsi + "type") is "SqlFilter" or "SqlRuleAction"))
			{
				part.Add(new XElement(part.Name.Namespace + "CompatibilityLevel", "20"));
				part.Add(new XElement(part.Name.Namespace + "RequiresPreprocessing", "true"));
			}
			return new(HttpStatusCode.OK)
			{
				Content = new StringContent(copy.ToString(), System.Text.Encoding.UTF8, "application/atom+xml")
			};
		}
	}
}
