import { tool } from 'ai';
import { z } from 'zod';

const chartInputSchema = z.object({
  chartType: z
    .enum(['line', 'bar', 'area', 'pie'])
    .describe('Type of chart to generate'),
  title: z.string().describe('Chart title describing what is visualized'),
  xAxisKey: z
    .string()
    .describe(
      'Property name to use for X axis (or category key for pie charts)',
    ),
  datasets: z
    .array(
      z.object({
        dataKey: z.string().describe('Property name for this data series'),
        label: z.string().describe('Display label for this data series'),
        color: z
          .string()
          .optional()
          .describe('HSL color like "hsl(220 70% 50%)" (optional)'),
      }),
    )
    .min(1)
    .describe('One or more data series to plot'),
  data: z
    .array(z.record(z.union([z.string(), z.number()])))
    .min(1)
    .max(2000)
    .describe('Array of data points (max 2000 points)'),
});

export type ChartInput = z.infer<typeof chartInputSchema>;

export const generateChart = tool({
  description: `Generate an interactive chart visualization from data.

Use this tool when the user asks for visual analysis, trends, comparisons,
distributions, or any request that would benefit from a chart.

Guidelines:
- Use 'line' for trends over time or continuous data
- Use 'bar' for comparisons between categories
- Use 'area' for cumulative values or filled trends over time
- Use 'pie' for part-to-whole relationships (max 8 slices recommended)

Keep data under 500 points when possible. For larger datasets,
aggregate in your SQL query before charting (e.g., GROUP BY date, category).`,

  inputSchema: chartInputSchema,

  execute: async (input): Promise<ChartInput> => {
    // Tool simply returns the input - the chart is rendered client-side
    return input;
  },
});
