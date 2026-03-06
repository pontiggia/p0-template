import { z } from 'zod';
import { db } from '@/db/client';
import { sql } from 'drizzle-orm';

export type SQLRow = Record<string, unknown>;

export interface SQLSuccess {
  readonly success: true;
  readonly data: readonly SQLRow[];
  readonly rowCount: number;
  readonly executionTimeMs: number;
}

export interface SQLError {
  readonly success: false;
  readonly error: string;
  readonly executionTimeMs: number;
}

export type SQLResult = SQLSuccess | SQLError;

const SQLResponseSchema = z.array(z.record(z.unknown())).nullable();

export async function executeReadOnlySQL(query: string): Promise<SQLResult> {
  const startTime: number = Date.now();

  const createError = (message: string): SQLError => ({
    success: false,
    error: message,
    executionTimeMs: Date.now() - startTime,
  });

  try {
    const result = await db.execute(
      sql`SELECT execute_readonly_sql(${query}) AS data`,
    );

    const data = (result.rows?.[0] as SQLRow | undefined)?.data;

    const parseResult = SQLResponseSchema.safeParse(data);
    if (!parseResult.success) {
      return createError(
        `Invalid response format: ${parseResult.error.message}`,
      );
    }

    const rows: readonly SQLRow[] = parseResult.data ?? [];

    return {
      success: true,
      data: rows,
      rowCount: rows.length,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown SQL execution error';
    return createError(message);
  }
}
