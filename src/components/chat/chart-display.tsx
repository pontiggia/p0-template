'use client';

import type { ReactNode } from 'react';
import { DataChart } from '@/components/data-chart';
import { validateChartConfig } from '@/lib/chart/config';
import { Skeleton } from '@/components/ui/skeleton';

interface ChartDisplayProps {
  readonly tool: {
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
    state: 'partial-call' | 'call' | 'result';
    result?: unknown;
  };
}

// Note: This component receives normalized tool invocations from MessageBubble
// The normalization maps AI SDK v6 format:
// - "output-available" -> "result"
// - input -> args
// - output -> result

export function ChartDisplay({ tool }: ChartDisplayProps): ReactNode {

  // Partial call - show skeleton
  if (tool.state === 'partial-call') {
    return (
      <div className="w-full my-3">
        <Skeleton className="h-8 w-48 mb-2" />
        <Skeleton className="h-[200px] sm:h-[300px] w-full rounded-lg" />
      </div>
    );
  }

  // Call in progress - show loading with partial info
  if (tool.state === 'call') {
    const title = (tool.args?.['title'] as string) ?? 'Generating chart...';
    return (
      <div
        className="w-full my-3 rounded-lg p-4"
        style={{
          backgroundColor: 'var(--gray-50)',
          border: '1px solid var(--border-color)',
        }}
      >
        <p
          className="text-sm font-medium mb-2"
          style={{ color: 'var(--foreground)' }}
        >
          {title}
        </p>
        <div className="flex items-center gap-2">
          <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
          <span className="text-sm" style={{ color: 'var(--gray-500)' }}>
            Processing data...
          </span>
        </div>
      </div>
    );
  }

  // Result available - validate and render
  // Try result first, then args (some tool states may have data in different places)
  let validation = validateChartConfig(tool.result);
  if (!validation.success) {
    validation = validateChartConfig(tool.args);
  }

  if (!validation.success) {
    // Check if we have any meaningful data to work with
    const hasResultData = tool.result !== undefined && tool.result !== null;
    const hasArgsData = tool.args !== undefined && Object.keys(tool.args).length > 0;

    // If no data at all, show loading (still streaming)
    if (!hasResultData && !hasArgsData) {
      return (
        <div
          className="w-full my-3 rounded-lg p-4"
          style={{
            backgroundColor: 'var(--gray-50)',
            border: '1px solid var(--border-color)',
          }}
        >
          <p
            className="text-sm font-medium mb-2"
            style={{ color: 'var(--foreground)' }}
          >
            Generating chart...
          </p>
          <div className="flex items-center gap-2">
            <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
            <span className="text-sm" style={{ color: 'var(--gray-500)' }}>
              Processing data...
            </span>
          </div>
        </div>
      );
    }

    // Tier 2: Attempt graceful degradation with result
    const fallback = attemptFallbackRender(tool.result);
    if (fallback) return fallback;

    // Also try fallback with args
    const fallbackArgs = attemptFallbackRender(tool.args);
    if (fallbackArgs) return fallbackArgs;

    // If we have partial data (title) but not enough for chart, show loading
    const title = (tool.args?.['title'] as string) ?? (tool.result as Record<string, unknown>)?.['title'] as string;
    const hasData = (tool.args?.['data'] as unknown[])?.length > 0 ||
                    ((tool.result as Record<string, unknown>)?.['data'] as unknown[])?.length > 0;

    if (!hasData) {
      return (
        <div
          className="w-full my-3 rounded-lg p-4"
          style={{
            backgroundColor: 'var(--gray-50)',
            border: '1px solid var(--border-color)',
          }}
        >
          <p
            className="text-sm font-medium mb-2"
            style={{ color: 'var(--foreground)' }}
          >
            {title ?? 'Generating chart...'}
          </p>
          <div className="flex items-center gap-2">
            <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
            <span className="text-sm" style={{ color: 'var(--gray-500)' }}>
              Rendering chart...
            </span>
          </div>
        </div>
      );
    }

    // Tier 3: Error display (only when we have data but it's truly malformed)
    return (
      <div
        className="w-full my-3 rounded-lg p-4 flex items-start gap-3"
        style={{
          backgroundColor: 'hsl(0 84% 60% / 0.1)',
          border: '1px solid hsl(0 84% 60% / 0.3)',
        }}
      >
        <svg
          className="h-5 w-5 flex-shrink-0 mt-0.5"
          style={{ color: '#ef4444' }}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <div>
          <p className="font-medium text-sm" style={{ color: '#dc2626' }}>
            Unable to render chart
          </p>
          <p className="text-sm mt-1" style={{ color: '#ef4444cc' }}>
            The chart configuration was invalid. The raw data is available in
            the response.
          </p>
        </div>
      </div>
    );
  }

  // Success - render chart
  return (
    <div className="w-full my-3">
      <DataChart config={validation.data} />
    </div>
  );
}

function attemptFallbackRender(result: unknown): ReactNode | null {
  try {
    const partial = result as Record<string, unknown>;
    const data = partial['data'] as Array<Record<string, unknown>> | undefined;

    if (data && Array.isArray(data) && data.length > 0) {
      const keys = Object.keys(data[0]);
      if (keys.length >= 2) {
        return (
          <DataChart
            config={{
              chartType: 'bar',
              title: (partial['title'] as string) ?? 'Data',
              xAxisKey: keys[0],
              datasets: [{ dataKey: keys[1], label: keys[1] }],
              data: data.map((d) =>
                Object.fromEntries(
                  Object.entries(d).map(([k, v]) => [k, v as string | number]),
                ),
              ),
            }}
          />
        );
      }
    }
  } catch {
    // Fallback failed
  }
  return null;
}
