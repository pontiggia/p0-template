import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Runs before every test file. Makes the run hermetic regardless of what the
// developer's shell or .env.local holds: no real Kapso, no Upstash, no
// Sandbox, no Anthropic (except the opt-in live suite), loopback-only fetch.

const LIVE = process.env.VITEST_LIVE === '1';

// The hermetic Pontimpo app's coordinates + keys (pnpm pontimpo:up writes it).
const testEnv = fileURLToPath(new URL('../.env.test.local', import.meta.url));
if (existsSync(testEnv)) process.loadEnvFile(testEnv);

for (const name of [
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'KV_URL',
  'VERCEL_SANDBOX_TOKEN',
  'VERCEL_OIDC_TOKEN',
  'KAPSO_BASE_URL',
]) {
  delete process.env[name];
}
if (!LIVE) delete process.env.ANTHROPIC_API_KEY;

// Kapso: fake credentials; each test points KAPSO_BASE_URL at its local stub.
process.env.KAPSO_API_KEY = 'stub-kapso-key';
process.env.KAPSO_PHONE_NUMBER_ID = 'stub-phone-number-id';
process.env.KAPSO_WEBHOOK_SECRET = 'test-webhook-secret';

// Fictitious numbers only — never a real staff number.
process.env.STAFF_ALLOWLIST = JSON.stringify({
  '5490000000001': { staffName: 'Oscar Prueba', onBehalfOf: 'oscar.prueba@test.local' },
});

// The agent talks to the hermetic app with the Phase-1 credential; the
// number→PK resolver reads the same hermetic DB.
if (process.env.PONTIMPO_TEST_AGENT_KEY) {
  process.env.PONTIMPO_API_KEY = process.env.PONTIMPO_TEST_AGENT_KEY;
  process.env.DATABASE_URL = process.env.PONTIMPO_TEST_DATABASE_URL;
}

// Network guard: loopback only (plus Anthropic for the live suite). A test
// that would reach Kapso, Upstash or any other host fails loudly instead.
const realFetch = globalThis.fetch;
const allowed = (host: string) =>
  host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ||
  (LIVE && host === 'api.anthropic.com');
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!allowed(url.hostname)) {
    return Promise.reject(new Error(`hermetic test blocked network call to ${url.hostname}`));
  }
  return realFetch(input, init);
};
