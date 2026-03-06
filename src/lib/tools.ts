import { tool } from 'ai';
import { z } from 'zod';
import {
  executeShellCommand,
  type SandboxResult,
  type ShellCommandResult,
} from './sandbox';
import {
  executeReadOnlySQL,
  type SQLRow,
  type SQLResult,
} from './sql-executor';
import { generateChart } from './tools/generate-chart';

const ExecuteCommandParamsSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe(
      'The shell command to execute (ls, cat, grep, find, head, tail, wc only)',
    ),
  reasoning: z
    .string()
    .min(1)
    .describe('Why you are running this command and what you expect to find'),
});

const ExecuteSQLParamsSchema = z.object({
  sql: z.string().min(1).describe('The SELECT query to execute'),
  explanation: z
    .string()
    .min(1)
    .describe('Brief explanation of what this query does and why'),
});

function logToolCall(
  tool: string,
  action: string,
  details: Record<string, unknown>,
): void {
  const timestamp = new Date().toISOString();
  console.log(
    `\n${'='.repeat(60)}\n[${timestamp}] [${tool}] ${action}\n${'='.repeat(60)}`,
  );
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string' && value.length > 200) {
      console.log(`  ${key}: ${value.substring(0, 200)}... (truncated)`);
    } else {
      console.log(`  ${key}:`, value);
    }
  }
}

export interface ExecuteCommandToolResult {
  readonly success: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly error?: string;
}

export interface ExecuteSQLToolResult {
  readonly success: boolean;
  readonly data?: readonly SQLRow[];
  readonly rowCount?: number;
  readonly executionTimeMs: number;
  readonly error?: string;
  readonly explanation: string;
  readonly query: string;
}

const EXECUTE_COMMAND_DESCRIPTION =
  `Execute a shell command to explore the semantic layer files.
The semantic layer is located at /tmp/catalog and contains:
- /tables/*.yaml - Table definitions with columns, types, indexes, common queries
- /views/*.yaml - View definitions with column mappings and example queries
- /relationships/joins.yaml - Join paths and relationship definitions
- /enums/enums.yaml - Enum values and mappings
- /functions/functions-overview.yaml - Available database functions
- /glossary.md - Business terms mapped to SQL equivalents
- /schema-overview.md - High-level database overview

Available commands: ls, cat, grep, find, head, tail, wc
Use these to explore and understand the schema before writing SQL.` as const;

const EXECUTE_SQL_DESCRIPTION =
  `Execute a read-only SQL query against the Postgres database.

IMPORTANT:
- Only SELECT queries are allowed
- Queries are limited to 1000 rows and 5 second timeout
- Always validate your query against the semantic layer first
- Use the column names and types from the YAML files
- Reference the joins.yaml for correct join patterns

Before using this tool:
1. Explore /tmp/catalog to understand the schema
2. Check glossary.md for business term mappings
3. Review common_queries in relevant table YAML files
4. Verify join relationships in relationships/joins.yaml` as const;

export const executeCommand = tool({
  description: EXECUTE_COMMAND_DESCRIPTION,
  inputSchema: ExecuteCommandParamsSchema,
  execute: async (input): Promise<ExecuteCommandToolResult> => {
    const startTime = Date.now();

    logToolCall('executeCommand', 'CALLED', {
      command: input.command,
      reasoning: input.reasoning,
    });

    const result: SandboxResult<ShellCommandResult> = await executeShellCommand(
      input.command,
    );

    const durationMs = Date.now() - startTime;

    if (result.success === false) {
      logToolCall('executeCommand', 'ERROR', {
        error: result.error,
        durationMs,
      });
      return {
        success: false,
        error: result.error,
      };
    }

    logToolCall('executeCommand', 'SUCCESS', {
      exitCode: result.data.exitCode,
      stdoutLength: result.data.stdout.length,
      stderrLength: result.data.stderr.length,
      durationMs,
      output: result.data.stdout || result.data.stderr || '(empty)',
    });

    return {
      success: true,
      stdout: result.data.stdout,
      stderr: result.data.stderr,
      exitCode: result.data.exitCode,
    };
  },
});

export const executeSQL = tool({
  description: EXECUTE_SQL_DESCRIPTION,
  inputSchema: ExecuteSQLParamsSchema,
  execute: async (input): Promise<ExecuteSQLToolResult> => {
    logToolCall('executeSQL', 'CALLED', {
      explanation: input.explanation,
      sql: input.sql,
    });

    const result: SQLResult = await executeReadOnlySQL(input.sql);

    if (result.success === false) {
      logToolCall('executeSQL', 'ERROR', {
        error: result.error,
        executionTimeMs: result.executionTimeMs,
      });
      return {
        success: false,
        error: result.error,
        executionTimeMs: result.executionTimeMs,
        explanation: input.explanation,
        query: input.sql,
      };
    }

    logToolCall('executeSQL', 'SUCCESS', {
      rowCount: result.rowCount,
      executionTimeMs: result.executionTimeMs,
      sampleData: result.data.slice(0, 3),
    });

    return {
      success: true,
      data: result.data,
      rowCount: result.rowCount,
      executionTimeMs: result.executionTimeMs,
      explanation: input.explanation,
      query: input.sql,
    };
  },
});

export const agentTools = {
  executeCommand,
  executeSQL,
  generateChart,
} as const;

export type AgentTools = typeof agentTools;
