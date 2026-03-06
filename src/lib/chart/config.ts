import { z } from 'zod';

export const chartConfigSchema = z.object({
  chartType: z.enum(['line', 'bar', 'area', 'pie']),
  title: z.string().min(1).max(200),
  xAxisKey: z.string().min(1).max(100),
  datasets: z
    .array(
      z.object({
        dataKey: z.string().min(1).max(100),
        label: z.string().min(1).max(100),
        color: z
          .string()
          .regex(/^hsl\(/)
          .optional(),
      }),
    )
    .min(1)
    .max(10),
  data: z
    .array(z.record(z.union([z.string(), z.number()])))
    .min(1)
    .max(2000),
});

export type ChartConfig = z.infer<typeof chartConfigSchema>;

// Branded type for validated configs
export type ValidatedChartConfig = ChartConfig & { __brand: 'validated' };

export function validateChartConfig(
  input: unknown,
):
  | { success: true; data: ValidatedChartConfig }
  | { success: false; error: z.ZodError } {
  const result = chartConfigSchema.safeParse(input);
  if (result.success) {
    return {
      success: true,
      data: { ...result.data, __brand: 'validated' } as ValidatedChartConfig,
    };
  }
  return { success: false, error: result.error };
}
