// Without Vercel Sandbox credentials (test/setup.ts deletes them), the
// catalog-exploration commands run locally — still whitelisted, still
// confined to ./semantic-catalog.
import { describe, expect, it } from 'vitest';

import { executeShellCommand } from '@/lib/sandbox';

describe('executeCommand local fallback (no VERCEL_SANDBOX_TOKEN / OIDC)', () => {
  it('runs a whitelisted command against the catalog, /tmp/catalog mapped to it', async () => {
    const res = await executeShellCommand('ls /tmp/catalog');
    expect(res).toMatchObject({ success: true, data: { exitCode: 0 } });
    expect(res.success && res.data.stdout).toContain('schema-overview.md');
  });

  it.each([
    'cat ../.env.local',
    'cat /etc/passwd',
    'grep -r KEY ~',
    'cat tables/../../package.json',
    'find . -delete',
    'find . -exec cat {} ;',
  ])('refuses %s', async (cmd) => {
    expect(await executeShellCommand(cmd)).toMatchObject({ success: false });
  });

  it('refuses commands outside the whitelist', async () => {
    expect(await executeShellCommand('rm -rf tables')).toMatchObject({ success: false });
  });
});
