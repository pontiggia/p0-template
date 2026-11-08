import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

/**
 * Fixtures + verification against the hermetic Pontimpo app (pnpm pontimpo:up).
 * Sales are created through the app's R1 service (makeFixtures); the *fixture*
 * credential reads products and mutates a sale "behind the agent's back".
 */

export function requirePontimpoApp() {
  const missing = ['PONTIMPO_API_URL', 'PONTIMPO_TEST_AGENT_KEY', 'PONTIMPO_TEST_FIXTURE_KEY', 'PONTIMPO_TEST_DATABASE_URL']
    .filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(`Pontimpo test app not configured (${missing.join(', ')}). Run: pnpm pontimpo:up`);
  }
  const db = new URL(process.env.PONTIMPO_TEST_DATABASE_URL!).pathname.slice(1);
  if (!db.startsWith('pontimpo_e2e')) throw new Error(`refusing non-hermetic database ${db}`);
}

export const PONTIMPO_DIR = new URL('../../../pontimpo-tire-system', import.meta.url).pathname;
const FIXTURE_SCRIPT = new URL('../../scripts/pontimpo-fixtures.mts', import.meta.url).pathname;

const api = (path: string) => `${process.env.PONTIMPO_API_URL}/api/v1${path}`;

async function call<T>(key: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(api(path), {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(method === 'POST' ? { 'Idempotency-Key': `fixture-${randomUUID()}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`fixture ${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

export const fixture = {
  get: <T>(path: string) => call<T>(process.env.PONTIMPO_TEST_FIXTURE_KEY!, 'GET', path),
  post: <T>(path: string, body: unknown) => call<T>(process.env.PONTIMPO_TEST_FIXTURE_KEY!, 'POST', path, body),
};

export interface FixtureSale {
  id: number;
  local_id: number;
  status: string;
  total_centavos: number;
  client_id: number;
  items: Array<{ id: number; product_id: number | null; quantity: number; unit_price_centavos: number }>;
}

export async function seededProducts() {
  const res = await fixture.get<{ data: Array<{ id: number; code: string; name: string; price_centavos: number; quantity_on_hand: number }> }>('/products');
  const byCode = (code: string) => {
    const p = res.data.find((x) => x.code === code);
    if (!p) throw new Error(`seed product ${code} missing`);
    return p;
  };
  return { tire: byCode('1001'), tire2: byCode('1002'), tube: byCode('2001') };
}

export interface FixtureSpec { product?: '1001' | '1002' | '2001'; quantity?: number; paid?: boolean }
export interface FixtureRow { clientId: number; clientLocalId: number; clientName: string; saleId?: number; saleLocalId?: number }

/**
 * Clients + sales through the app's own recipes (createClient, R1) as the
 * seeded superadmin — scripts/pontimpo-fixtures.mts under pontimpo's tsx.
 * One spawn per call; batch the specs a suite needs.
 */
export function makeFixtures(specs: FixtureSpec[]): FixtureRow[] {
  const run = spawnSync(`${PONTIMPO_DIR}/node_modules/.bin/tsx`, [FIXTURE_SCRIPT, JSON.stringify(specs)], {
    cwd: PONTIMPO_DIR,
    env: { ...process.env, DATABASE_URL: process.env.PONTIMPO_TEST_DATABASE_URL },
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`fixtures failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

export const getSaleAsFixture = (id: number) => fixture.get<FixtureSale>(`/sales/${id}`);

// ── Direct DB reads for verification (never writes) ─────────────────────────

let pool: Pool | null = null;
export function testDb(): Pool {
  pool ??= new Pool({ connectionString: process.env.PONTIMPO_TEST_DATABASE_URL, max: 2 });
  return pool;
}
export async function closeTestDb() {
  await pool?.end();
  pool = null;
}

export async function agentCredentialId(): Promise<number> {
  const { rows } = await testDb().query<{ id: string }>(
    "SELECT id FROM api_credential WHERE name LIKE 'S6 test — agente%'",
  );
  return Number(rows[0].id);
}

export async function ledgerForSale(saleId: number) {
  const { rows } = await testDb().query(
    `SELECT id, kind, amount_centavos::bigint::int AS amount, payment_method, currency,
            amount_usd_centavos::int AS usd, fx_rate_centavos::int AS fx,
            created_by_credential_id::int AS credential_id, on_behalf_of, description, reverses_entry_id
       FROM client_ledger_entry WHERE sale_id = $1 ORDER BY id`,
    [saleId],
  );
  return rows;
}

export async function ledgerForClient(clientId: number) {
  const { rows } = await testDb().query(
    `SELECT id, kind, amount_centavos::bigint::int AS amount, payment_method, sale_id,
            created_by_credential_id::int AS credential_id, on_behalf_of, description
       FROM client_ledger_entry WHERE client_id = $1 ORDER BY id`,
    [clientId],
  );
  return rows;
}

export async function cashForLedger(ledgerEntryIds: number[]) {
  if (ledgerEntryIds.length === 0) return [];
  const { rows } = await testDb().query(
    `SELECT kind, method, amount_centavos::bigint::int AS amount, ledger_entry_id::int AS ledger_entry_id
       FROM cash_movement WHERE ledger_entry_id = ANY($1::bigint[]) ORDER BY id`,
    [ledgerEntryIds],
  );
  return rows;
}

export async function auditFor(entityType: string, entityId: number) {
  const { rows } = await testDb().query(
    `SELECT action, actor_type, actor_credential_id::int AS credential_id, on_behalf_of
       FROM audit_event WHERE entity_type = $1 AND entity_id = $2 ORDER BY id`,
    [entityType, entityId],
  );
  return rows;
}

export async function stockOf(productId: number): Promise<number> {
  const { rows } = await testDb().query<{ q: number }>(
    'SELECT quantity_on_hand::int AS q FROM product WHERE id = $1',
    [productId],
  );
  return rows[0].q;
}
