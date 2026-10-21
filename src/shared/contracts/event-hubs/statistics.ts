import { z } from 'zod'
export const eventOperationStatisticsSchema = z
	.object({
		successfulCalls: z.number().int().nonnegative(),
		failedCalls: z.number().int().nonnegative(),
		emptyCalls: z.number().int().nonnegative(),
		totalCallMs: z.number().nonnegative(),
		minCallMs: z.number().nonnegative().nullable(),
		maxCallMs: z.number().nonnegative().nullable(),
		bodyEvents: z.number().int().nonnegative(),
		bodyBytes: z.number().int().nonnegative(),
		minBodyBytes: z.number().int().nonnegative().nullable(),
		maxBodyBytes: z.number().int().nonnegative().nullable(),
	})
	.strict()
export type EventOperationStatistics = z.infer<typeof eventOperationStatisticsSchema>
