import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Hermetic suite: stubs + the local Pontimpo test app (pnpm pontimpo:up).
// No LLM (scripted MockLanguageModelV4), no Kapso (local stub), and a fetch
// guard in test/setup.ts that rejects anything but loopback.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/live/**'],
    setupFiles: ['test/setup.ts'],
    // The API suites share one Pontimpo DB; run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
