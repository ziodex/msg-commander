using System.Text.RegularExpressions;
using MsgCommander.Domain.Common;

namespace MsgCommander.Domain.NotificationHubs;

public static class NotificationTagFilter
{
	public static void Validate(string expression)
	{
		Parse(expression);
	}

	public static bool Matches(string expression, IReadOnlySet<string> tags) => Parse(expression)(tags);
	private static Func<IReadOnlySet<string>, bool> Parse(string expression)
	{
		if (string.IsNullOrWhiteSpace(expression) || expression.Length > 1024 || expression.Any(c => char.IsControl(c)))
			throw Invalid();
		var offset = 0;
		var count = 0;
		var and = false;
		var or = false;
		var negated = false;
		void Space()
		{
			while (offset < expression.Length && expression[offset] == ' ')
				offset++;
		}

		bool Take(string token)
		{
			Space();
			if (!expression.AsSpan(offset).StartsWith(token, StringComparison.Ordinal))
				return false;
			offset += token.Length;
			return true;
		}

		Func<IReadOnlySet<string>, bool> Primary(int depth)
		{
			if (depth > 16)
				throw Invalid();
			if (Take("!"))
			{
				negated = true;
				var child = Primary(depth + 1);
				return tags => !child(tags);
			}

			if (Take("("))
			{
				var child = Or(depth + 1);
				if (!Take(")"))
					throw Invalid();
				return child;
			}

			Space();
			var match = Regex.Match(expression[offset..], @"^[A-Za-z0-9_@#.:~-]{1,120}");
			if (!match.Success || match.Value is "." or "..")
				throw Invalid();
			offset += match.Length;
			count++;
			var tag = match.Value;
			return tags => tags.Contains(tag);
		}

		Func<IReadOnlySet<string>, bool> And(int depth)
		{
			var left = Primary(depth);
			while (Take("&&"))
			{
				and = true;
				var first = left;
				var right = Primary(depth);
				left = tags => first(tags) && right(tags);
			}

			return left;
		}

		Func<IReadOnlySet<string>, bool> Or(int depth)
		{
			var left = And(depth);
			while (Take("||"))
			{
				or = true;
				var first = left;
				var right = And(depth);
				left = tags => first(tags) || right(tags);
			}

			return left;
		}

		var result = Or(0);
		Space();
		if (offset != expression.Length || count > (and && !or ? 10 : !and && !negated ? 20 : 6))
			throw Invalid();
		return result;
	}

	private static DomainRuleException Invalid() => new("Use tags with &&, ||, ! and parentheses: at most 20 tags for OR, 10 for AND, or 6 when combined; nesting is limited to 16.");
}
