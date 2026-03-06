'use client';

import type { ReactNode } from 'react';

interface DataTableProps {
  readonly title: string;
  readonly xAxisKey: string;
  readonly datasets: Array<{ dataKey: string; label: string; color?: string }>;
  readonly data: Array<Record<string, string | number>>;
}

export function DataTable({
  title,
  xAxisKey,
  datasets,
  data,
}: DataTableProps): ReactNode {
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
      <div className="overflow-auto" style={{ maxHeight: '300px' }}>
        <table
          className="w-full text-sm"
          style={{
            borderCollapse: 'collapse',
            border: '1px solid var(--border-color)',
          }}
        >
          <thead
            style={{
              backgroundColor: 'var(--gray-100)',
              position: 'sticky',
              top: 0,
            }}
          >
            <tr>
              <th
                className="px-3 py-2 text-left font-semibold"
                style={{
                  borderRight: '1px solid var(--border-color)',
                  borderBottom: '1px solid var(--border-color)',
                  color: 'var(--foreground)',
                }}
              >
                {xAxisKey}
              </th>
              {datasets.map((dataset) => (
                <th
                  key={dataset.dataKey}
                  className="px-3 py-2 text-right font-semibold"
                  style={{
                    borderRight: '1px solid var(--border-color)',
                    borderBottom: '1px solid var(--border-color)',
                    color: 'var(--foreground)',
                  }}
                >
                  {dataset.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, index) => (
              <tr
                key={index}
                style={{ borderBottom: '1px solid var(--border-color)' }}
              >
                <td
                  className="px-3 py-2"
                  style={{
                    borderRight: '1px solid var(--border-color)',
                    color: 'var(--foreground)',
                  }}
                >
                  {row[xAxisKey]}
                </td>
                {datasets.map((dataset) => (
                  <td
                    key={dataset.dataKey}
                    className="px-3 py-2 text-right tabular-nums"
                    style={{
                      borderRight: '1px solid var(--border-color)',
                      color: 'var(--foreground)',
                    }}
                  >
                    {typeof row[dataset.dataKey] === 'number'
                      ? row[dataset.dataKey].toLocaleString()
                      : row[dataset.dataKey]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
