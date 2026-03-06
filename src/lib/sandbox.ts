/* eslint-disable @typescript-eslint/no-explicit-any */

import { Sandbox } from '@vercel/sandbox';
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
