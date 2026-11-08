import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Live suite (pnpm test:live): the seven mutating recipes end-to-end through
// the REAL agent loop (Anthropic). Skipped unless ANTHROPIC_API_KEY is set.
// Kapso is still the local stub; Pontimpo is the hermetic test app.
export default defineConfig({
  test: {
    include: ['test/live/**/*.live.test.ts'],
    setupFiles: ['test/setup.ts'],
    env: { VITEST_LIVE: '1' },
    fileParallelism: false,
    testTimeout: 240_000,
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
