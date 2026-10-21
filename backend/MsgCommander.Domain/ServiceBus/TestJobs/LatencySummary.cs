namespace MsgCommander.Domain.ServiceBus.TestJobs;

public sealed record LatencySummary(int Samples, double? MinMs, double? MeanMs, double? P50Ms, double? P95Ms, double? P99Ms, double? MaxMs)
{
	public static LatencySummary From(List<double> values)
	{
		if (values.Count == 0)
			return new(0, null, null, null, null, null, null);
		values.Sort();
		double Round(double value) => Math.Round(value, 3);
		double Percentile(double p) => Round(values[(int)Math.Ceiling(p * values.Count) - 1]);
		return new(values.Count, Round(values[0]), Round(values.Average()), Percentile(.5), Percentile(.95), Percentile(.99), Round(values[^1]));
	}
}
