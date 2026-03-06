'use client';

import type { ReactNode } from 'react';
import {
  Bar,
  BarChart,
  Line,
  LineChart,
  Area,
  AreaChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Cell,
} from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig as ShadcnChartConfig,
} from '@/components/ui/chart';
import { DataTable } from '@/components/data-table';
import type { ValidatedChartConfig } from '@/lib/chart/config';

const MAX_BAR_ITEMS = 7;

interface DataChartProps {
  readonly config:
    | ValidatedChartConfig
    | {
        chartType: 'line' | 'bar' | 'area' | 'pie';
        title: string;
        xAxisKey: string;
        datasets: Array<{ dataKey: string; label: string; color?: string }>;
        data: Array<Record<string, string | number>>;
      };
}

export function DataChart({ config }: DataChartProps): ReactNode {
  const { chartType, title, xAxisKey, datasets, data } = config;

  // Auto-switch: render table instead of bar chart when too many items
  const shouldUseTable = chartType === 'bar' && data.length > MAX_BAR_ITEMS;

  if (shouldUseTable) {
    return (
      <DataTable
        title={title}
        xAxisKey={xAxisKey}
        datasets={datasets as Array<{ dataKey: string; label: string; color?: string }>}
        data={data}
      />
    );
  }

  const chartConfig: ShadcnChartConfig = Object.fromEntries(
    datasets.map((dataset, index) => [
      dataset.dataKey,
      {
        label: dataset.label,
        color: dataset.color ?? `hsl(var(--chart-${index + 1}))`,
      },
    ]),
  );

  const formatXAxisTick = (value: string | number): string => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      const [, month, day] = value.split('-');
      return `${day}/${month}`;
    }
    return String(value);
  };

  const renderChart = () => {
    const commonAxisProps = {
      tickLine: false,
      axisLine: false,
      tick: { fontSize: 11 },
    };

    const effectiveDataLength = data.length;

    const xAxisProps = {
      ...commonAxisProps,
      angle: effectiveDataLength > 5 ? -45 : 0,
      textAnchor:
        effectiveDataLength > 5 ? ('end' as const) : ('middle' as const),
      height: effectiveDataLength > 5 ? 60 : 30,
    };

    const timeSeriesXAxisProps = {
      ...xAxisProps,
      interval:
        data.length <= 10 ? (0 as const) : ('preserveStartEnd' as const),
      tick: { fontSize: 10 },
    };

    const chartMargin = { left: 5, right: 5, bottom: 5 };

    switch (chartType) {
      case 'bar':
        return (
          <BarChart data={data} margin={chartMargin} accessibilityLayer>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey={xAxisKey}
              {...xAxisProps}
              tickFormatter={formatXAxisTick}
            />
            <YAxis {...commonAxisProps} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {datasets.map((dataset) => (
              <Bar
                key={dataset.dataKey}
                dataKey={dataset.dataKey}
                fill={`var(--color-${dataset.dataKey})`}
                radius={[4, 4, 0, 0]}
              />
            ))}
          </BarChart>
        );

      case 'line':
        return (
          <LineChart data={data} margin={chartMargin} accessibilityLayer>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey={xAxisKey}
              {...timeSeriesXAxisProps}
              tickFormatter={formatXAxisTick}
            />
            <YAxis {...commonAxisProps} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {datasets.map((dataset) => (
              <Line
                key={dataset.dataKey}
                type="monotone"
                dataKey={dataset.dataKey}
                stroke={`var(--color-${dataset.dataKey})`}
                strokeWidth={2}
                dot={data.length < 50}
                activeDot={{ r: 6 }}
              />
            ))}
          </LineChart>
        );

      case 'area':
        return (
          <AreaChart data={data} margin={chartMargin} accessibilityLayer>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey={xAxisKey}
              {...timeSeriesXAxisProps}
              tickFormatter={formatXAxisTick}
            />
            <YAxis {...commonAxisProps} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {datasets.map((dataset) => (
              <Area
                key={dataset.dataKey}
                type="monotone"
                dataKey={dataset.dataKey}
                fill={`var(--color-${dataset.dataKey})`}
                fillOpacity={0.4}
                stroke={`var(--color-${dataset.dataKey})`}
                strokeWidth={2}
              />
            ))}
          </AreaChart>
        );

      case 'pie': {
        const COLORS = datasets.map(
          (d, i) => d.color ?? `hsl(var(--chart-${(i % 5) + 1}))`,
        );
        return (
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent />} />
            <Pie
              data={data}
              dataKey={datasets[0]?.dataKey ?? 'value'}
              nameKey={xAxisKey}
              cx="50%"
              cy="50%"
              innerRadius="35%"
              outerRadius="65%"
              paddingAngle={2}
            >
              {data.map((_, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={COLORS[index % COLORS.length]}
                />
              ))}
            </Pie>
          </PieChart>
        );
      }
    }
  };

  return (
    <div
      className="rounded-lg p-4"
      style={{
        backgroundColor: 'var(--background)',
        border: '1px solid var(--border-color)',
      }}
    >
      <h3
        className="text-base font-semibold mb-4"
        style={{ color: 'var(--foreground)' }}
      >
        {title}
      </h3>
      <ChartContainer
        config={chartConfig}
        className="min-h-[200px] sm:min-h-[300px] w-full"
      >
        {renderChart()}
      </ChartContainer>
    </div>
  );
}
