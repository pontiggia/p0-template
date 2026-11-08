/* eslint-disable @typescript-eslint/no-explicit-any */

import { Sandbox } from '@vercel/sandbox';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { getSemanticCatalogFiles } from './semantic-layer';
import type { SemanticCatalogFiles } from './semantic-layer';

const ALLOWED_COMMANDS = [
  'ls',
  'cat',
  'grep',
  'find',
  'head',
  'tail',
  'wc',
] as const;
type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

export interface ShellCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type SandboxResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export interface ShellCommandOptions {
  readonly timeoutMs?: number;
}

let sandboxInstance: Sandbox | null = null;

function isAllowedCommand(cmd: string): cmd is AllowedCommand {
  return ALLOWED_COMMANDS.includes(cmd as AllowedCommand);
}

const CATALOG_PATH = '/tmp/catalog';

async function getOrCreateSandbox(): Promise<SandboxResult<Sandbox>> {
  if (sandboxInstance !== null) {
    return { success: true, data: sandboxInstance };
  }

  try {
    console.log('[Sandbox] Creating new sandbox...');

    const sandbox = await Sandbox.create({
      timeout: 30000, // 30 seconds timeout per command
    });

    console.log('[Sandbox] Sandbox created, mounting catalog files...');

    const catalogResult = await getSemanticCatalogFiles();
    if (!catalogResult.success) {
      await sandbox.stop();
      return {
        success: false,
        error: `Failed to load catalog: ${(catalogResult as any).error}`,
      };
    }

    const files: SemanticCatalogFiles = catalogResult.files;
    console.log(`[Sandbox] Found ${files.size} files in semantic-catalog`);

    const fileBuffers = Array.from(files.entries()).map(([path, content]) => ({
      path: `${CATALOG_PATH}/${path}`,
      content: Buffer.from(content, 'utf-8'),
    }));

    await sandbox.writeFiles(fileBuffers);
    console.log('[Sandbox] All catalog files mounted successfully');

    // Verify the mount
    const lsResult = await sandbox.runCommand({
      cmd: 'ls',
      args: ['-la', CATALOG_PATH],
    });
    const lsOutput = await lsResult.stdout();
    console.log('[Sandbox] Catalog directory contents:', lsOutput);

    sandboxInstance = sandbox;
    return { success: true, data: sandbox };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown sandbox creation error';
    console.error('[Sandbox] Error creating sandbox:', message);
    return { success: false, error: message };
  }
}

export async function executeShellCommand(
  command: string,
  _options: ShellCommandOptions = {},
  _retryCount: number = 0,
): Promise<SandboxResult<ShellCommandResult>> {
  const trimmedCommand = command.trim();
  const firstWord = trimmedCommand.split(/\s+/)[0];

  if (firstWord === undefined || !isAllowedCommand(firstWord)) {
    return {
      success: false,
      error: `Command not allowed: "${firstWord ?? '(empty)'}". Allowed: ${ALLOWED_COMMANDS.join(', ')}`,
    };
  }

  if (!hasVercelSandboxAuth()) {
    return executeLocally(trimmedCommand);
  }

  const sandboxResult = await getOrCreateSandbox();
  if (!sandboxResult.success) {
    return sandboxResult as any;
  }

  const sandbox = sandboxResult.data;

  try {
    const parts = trimmedCommand.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    const result = await sandbox.runCommand({
      cmd,
      args,
      cwd: CATALOG_PATH,
    });

    const [stdoutStr, stderrStr] = await Promise.all([
      result.stdout(),
      result.stderr(),
    ]);

    return {
      success: true,
      data: {
        stdout: stdoutStr,
        stderr: stderrStr,
        exitCode: result.exitCode,
      },
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown command execution error';

    const is410Error =
      message.includes('410') ||
      message.includes('Gone') ||
      message.includes('status code 410');

    if (is410Error) {
      console.error(
        '[Sandbox] Session expired (HTTP 410). The sandbox was terminated by Vercel after its lifetime expired.',
      );

      if (_retryCount === 0) {
        console.log('[Sandbox] Clearing stale sandbox and retrying command...');
        sandboxInstance = null;

        return executeShellCommand(command, _options, 1);
      } else {
        console.error(
          '[Sandbox] Retry failed. Sandbox session expired again after recreation.',
        );
        return {
          success: false,
          error:
            'Sandbox session expired and retry failed. Please try again in a moment.',
        };
      }
    }

    console.error('[Sandbox] Command execution error:', message);
    return { success: false, error: message };
  }
}

export async function destroySandbox(): Promise<void> {
  if (sandboxInstance !== null) {
    await sandboxInstance.stop();
    sandboxInstance = null;
  }
}

// ── Local fallback (no Vercel Sandbox credentials) ──────────────────────────
//
// Local runs (dev, the S6 live suite) have no VERCEL_SANDBOX_TOKEN and no
// VERCEL_OIDC_TOKEN (the deploy gets the latter automatically, so the real
// deploy keeps the Sandbox path). Then the same whitelisted, read-only commands
// run directly against ./semantic-catalog: execFile (no shell), cwd pinned to
// the catalog, `/tmp/catalog` rewritten to it, and no argument may leave it.
// SQL is unaffected — it always goes through DATABASE_URL (a read-only role).

const LOCAL_CATALOG_DIR = path.join(process.cwd(), 'semantic-catalog');
const LOCAL_TIMEOUT_MS = 5_000;
/** find actions that execute, delete or write files. */
const FORBIDDEN_FIND_ARGS = /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/;

function hasVercelSandboxAuth(): boolean {
  return Boolean(process.env.VERCEL_SANDBOX_TOKEN || process.env.VERCEL_OIDC_TOKEN);
}

/** Map the sandbox mount path onto the local catalog; null if the arg escapes it. */
function localArg(arg: string): string | null {
  const mapped =
    arg === CATALOG_PATH ? '.' : arg.startsWith(`${CATALOG_PATH}/`) ? arg.slice(CATALOG_PATH.length + 1) : arg;
  if (mapped.startsWith('/') || mapped.startsWith('~')) return null;
  if (mapped.split(/[/=]/).includes('..')) return null;
  return mapped;
}

function executeLocally(command: string): Promise<SandboxResult<ShellCommandResult>> {
  const [cmd, ...rawArgs] = command.split(/\s+/);
  const args: string[] = [];
  for (const raw of rawArgs) {
    const arg = localArg(raw);
    if (arg === null) {
      return Promise.resolve({ success: false, error: `Path outside the catalog: "${raw}"` });
    }
    if (cmd === 'find' && FORBIDDEN_FIND_ARGS.test(arg)) {
      return Promise.resolve({ success: false, error: `find action not allowed: "${arg}"` });
    }
    args.push(arg);
  }
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: LOCAL_CATALOG_DIR, timeout: LOCAL_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? '' }, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ success: true, data: { stdout, stderr, exitCode } });
      },
    );
  });
}
