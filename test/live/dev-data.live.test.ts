// S6 live run against a LOCAL copy of the migrated real data (pontimpo_dev, or
// a fresh `createdb -T pontimpo_dev pontimpo_s6live` for a one-pass run) — the
// Pontimpo app on :3201, the Phase-1 credential minted through the app's own
// service, the REAL agent loop (Anthropic). Kapso is the local stub; the
// allowlist maps a fake number to a real Las Flores admin (on_behalf_of).
//
//   PONTIMPO_TARGET=dev [PONTIMPO_DEV_ENV=.env.s6live.local] ANTHROPIC_API_KEY=… pnpm test:live
//
// For each mutating recipe it asserts EVERY row the recipe wrote to store 1
// (ledger, cash, stock, audit — captured as the delta past a watermark) against
// DOMAIN_SPEC §3, then the analytics answers against Pontimpo's own
// /api/v1/metrics + /debtors, then the hard paths. The target records are
// picked at run time by their SHAPE (see pickTargets), never by id, so the
// suite re-runs on data a previous run already changed. Evidence ids go to
// $S6_EVIDENCE_FILE when set.
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatCentavos } from '@/lib/money';
import { analyticsToolsMock, harness, pontimpoToolsMock, tap, text } from '../helpers/agent-harness';
import { startKapsoStub, type KapsoStub } from '../helpers/kapso-stub';

const h = vi.hoisted(() => ({ modelCalls: 0, turns: 0, usage: [] as unknown[], background: [] as Promise<unknown>[] }));

// The real Anthropic provider, metered: every doGenerate is one model call.
vi.mock('@ai-sdk/anthropic', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ai-sdk/anthropic')>();
  const anthropic = (id: string) => {
    h.turns++;
    const model = real.anthropic(id);
    return new Proxy(model, {
      get(target, prop, receiver) {
        if (prop === 'doGenerate') {
          return async (opts: Parameters<typeof model.doGenerate>[0]) => {
            h.modelCalls++;
            const res = await target.doGenerate(opts);
            h.usage.push(res.usage);
            return res;
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  };
  return { ...real, anthropic };
});
vi.mock('@/lib/pontimpo/tools', (io) => pontimpoToolsMock(io));
vi.mock('@/lib/tools', (io) => analyticsToolsMock(io));
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => void h.background.push(p) }));


const LIVE = Boolean(process.env.ANTHROPIC_API_KEY) && process.env.PONTIMPO_TARGET === 'dev';

const FROM = '5490000000001';
const STRANGER = '5490000000999';
const MUTATIONS = ['cancelSale', 'refundSale', 'correctSaleAmount', 'reversePayment', 'swapSaleLine', 'registerSalePayment', 'registerClientPayment'];

let pool: Pool;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows as T[];

interface Marks { ledger: number; cash: number; stock: number; audit: number }
async function marks(): Promise<Marks> {
  const [m] = await q<Marks>(`SELECT
    (SELECT coalesce(max(id),0) FROM client_ledger_entry)::int AS ledger,
    (SELECT coalesce(max(id),0) FROM cash_movement)::int AS cash,
    (SELECT coalesce(max(id),0) FROM stock_movement)::int AS stock,
    (SELECT coalesce(max(id),0) FROM audit_event)::int AS audit`);
  return m;
}
/** Every row written to store 1 since `m` — what the recipe actually did. */
async function delta(m: Marks) {
  const ledger = await q<{ id: number; kind: string; amount: number; payment_method: string | null; currency: string; usd: number | null; fx: number | null; sale_id: number | null; client_id: number; credential_id: number | null; user_id: number | null; on_behalf_of: string | null; reverses_entry_id: number | null; description: string | null }>(
    `SELECT id::int, kind, amount_centavos::int AS amount, payment_method, currency, amount_usd_centavos::int AS usd,
            fx_rate_centavos::int AS fx, sale_id::int, client_id::int, created_by_credential_id::int AS credential_id,
            created_by_user_id::int AS user_id, on_behalf_of, reverses_entry_id::int, description
       FROM client_ledger_entry WHERE id > $1 AND store_id = 1 ORDER BY id`, [m.ledger]);
  const cash = await q<{ id: number; kind: string; method: string; amount: number; currency: string; usd: number | null; fx: number | null; ledger_entry_id: number | null; reverses_movement_id: number | null }>(
    `SELECT id::int, kind, method, amount_centavos::int AS amount, currency, amount_usd_centavos::int AS usd,
            fx_rate_centavos::int AS fx, ledger_entry_id::int, reverses_movement_id::int
       FROM cash_movement WHERE id > $1 AND store_id = 1 ORDER BY id`, [m.cash]);
  const stock = await q<{ id: number; product_id: number; kind: string; delta: number; sale_item_id: number | null }>(
    `SELECT id::int, product_id::int, kind, quantity_delta AS delta, sale_item_id::int
       FROM stock_movement WHERE id > $1 AND store_id = 1 ORDER BY id`, [m.stock]);
  const audit = await q<{ id: number; action: string; actor_type: string; credential_id: number | null; on_behalf_of: string | null; entity_type: string; entity_id: number }>(
    `SELECT id::int, action, actor_type, actor_credential_id::int AS credential_id, on_behalf_of, entity_type, entity_id::int
       FROM audit_event WHERE id > $1 AND (store_id = 1 OR store_id IS NULL) ORDER BY id`, [m.audit]);
  return { ledger, cash, stock, audit };
}
const sale = async (id: number) => (await q<{ status: string; total: number }>(
  'SELECT status, total_centavos::int AS total FROM sale WHERE id = $1', [id]))[0];
const items = (saleId: number) => q<{ id: number; product_id: number | null; unit: number; total: number; description: string }>(
  'SELECT id::int, product_id::int, unit_price_centavos::int AS unit, total_centavos::int AS total, description FROM sale_item WHERE sale_id = $1 ORDER BY id', [saleId]);
const stockOf = async (productId: number) => (await q<{ n: number }>('SELECT quantity_on_hand AS n FROM product WHERE id = $1', [productId]))[0].n;
/** The app's own derivation (GET /sales/{id}) — R11 reversal adjustments count against "paid". */
const debtOfSale = async (saleId: number) => {
  const res = await fetch(`${process.env.PONTIMPO_API_URL}/api/v1/sales/${saleId}`, { headers: { Authorization: `Bearer ${process.env.PONTIMPO_DEV_FIXTURE_KEY}` } });
  return ((await res.json()) as { debt_centavos: number }).debt_centavos;
};


// ── Targets, picked by shape (store 1 only) ──────────────────────────────
interface SaleTarget {
  saleId: number; localId: number; clientId: number; status: string; total: number;
  itemId: number; productId: number; qty: number; unit: number;
}
interface PaidTarget extends SaleTarget { paymentId: number; cashId: number }
interface SwapTarget extends SaleTarget { fromCode: string; fromDetails: string; toId: number; toCode: string; toDetails: string }
interface Targets {
  r2: SaleTarget; r4: { clientId: number; localId: number; name: string; debt: number };
  r5: SaleTarget; r6: PaidTarget; r7: SaleTarget; r11: PaidTarget; r12: SwapTarget; conflict: SaleTarget;
  scope: { productId: number; code: string; price: number };
}

/** Sales with exactly one product line whose qty × unit = total (excluding `$1`). */
const ONE_LINE = `WITH one_line AS (
  SELECT s.id::int AS "saleId", s.local_id AS "localId", s.client_id::int AS "clientId", s.status,
         s.total_centavos::float8 AS total, min(i.id)::int AS "itemId", min(i.product_id)::int AS "productId",
         min(i.quantity)::int AS qty, min(i.unit_price_centavos)::float8 AS unit
    FROM sale s JOIN sale_item i ON i.sale_id = s.id AND i.store_id = s.store_id
   WHERE s.store_id = 1 AND s.total_centavos > 0 AND NOT (s.id = ANY($1::bigint[]))
   GROUP BY s.id HAVING count(*) = 1 AND bool_and(i.kind = 'product'))`;
/** pending with no ledger entry but its own `sale` one — no payments, no corrections. */
const UNTOUCHED_PENDING = `o.status = 'pending' AND o.qty * o.unit = o.total
  AND NOT EXISTS (SELECT 1 FROM client_ledger_entry l WHERE l.sale_id = o."saleId" AND l.kind <> 'sale')`;

async function pickTargets(): Promise<Targets> {
  const used: number[] = [];
  const one = async <T extends SaleTarget>(label: string, sql: string): Promise<T> => {
    const [row] = await q<T>(sql, [used]);
    if (!row) throw new Error(`no ${label} candidate left in store 1`);
    used.push(row.saleId);
    return row;
  };
  const pending = (label: string, extra = 'TRUE') =>
    one<SaleTarget>(label, `${ONE_LINE} SELECT o.* FROM one_line o WHERE ${UNTOUCHED_PENDING} AND ${extra} ORDER BY o."saleId" DESC LIMIT 1`);
  /** paid by exactly one ARS efectivo payment of the whole total, with its cash row. */
  const paid = (label: string, extra = 'TRUE') =>
    one<PaidTarget>(label, `${ONE_LINE}
      SELECT o.*, p.id::int AS "paymentId", m.id::int AS "cashId"
        FROM one_line o
        JOIN client_ledger_entry p ON p.sale_id = o."saleId" AND p.kind = 'payment' AND p.payment_method = 'efectivo'
                                  AND p.currency = 'ARS' AND p.amount_centavos = -o.total
        JOIN cash_movement m ON m.ledger_entry_id = p.id AND m.kind = 'payment_received'
       WHERE o.status = 'paid' AND o.qty * o.unit = o.total AND ${extra}
         AND (SELECT count(*) FROM client_ledger_entry l WHERE l.sale_id = o."saleId" AND l.kind <> 'sale') = 1
       ORDER BY o."saleId" DESC LIMIT 1`);

  // R12 first (the scarcest shape): an untouched pending sale whose product has an
  // active same-price tire with enough stock to swap to.
  const r12 = await one<SwapTarget>('R12 swap', `${ONE_LINE}
    SELECT o.*, f.code AS "fromCode", f.details AS "fromDetails", t.id::int AS "toId", t.code AS "toCode", t.details AS "toDetails"
      FROM one_line o
      JOIN product f ON f.id = o."productId" AND f.details IS NOT NULL
      JOIN LATERAL (SELECT p.id, p.code, p.details FROM product p
                     WHERE p.store_id = 1 AND p.is_active AND p.is_tire AND p.id <> o."productId" AND p.details IS NOT NULL
                       AND p.price_centavos = o.unit AND p.quantity_on_hand >= o.qty
                     ORDER BY p.id LIMIT 1) t ON TRUE
     WHERE ${UNTOUCHED_PENDING}
     ORDER BY o."saleId" DESC LIMIT 1`);
  const r7 = await pending('R7 (qty 2)', 'o.qty = 2');
  const conflict = await pending('CONFLICT (qty 1)', 'o.qty = 1');
  const r5 = await pending('R5');
  const r2 = await pending('R2');
  const r11 = await paid('R11 (total ÷ 4 in whole centavos)', 'o.total::bigint % 4 = 0');
  const r6 = await paid('R6');
  // A debtor above US$100 @ 1.485 with an unambiguous name.
  const [r4] = await q<Targets['r4']>(`
    SELECT c.id::int AS "clientId", c.local_id AS "localId", c.name, sum(l.amount_centavos)::float8 AS debt
      FROM client c JOIN client_ledger_entry l ON l.client_id = c.id AND l.store_id = 1
     WHERE c.store_id = 1
       AND NOT EXISTS (SELECT 1 FROM client d WHERE d.store_id = 1 AND d.id <> c.id AND lower(d.name) = lower(c.name))
     GROUP BY c.id HAVING sum(l.amount_centavos) >= 20000000
     ORDER BY sum(l.amount_centavos), c.id LIMIT 1`);
  const [scope] = await q<Targets['scope']>(`SELECT id::int AS "productId", code, price_centavos::float8 AS price
      FROM product WHERE store_id = 1 AND is_active AND price_centavos > 0 ORDER BY id LIMIT 1`);
  if (!r4 || !scope) throw new Error('no R4 debtor / scope product in store 1');
  return { r2, r4, r5, r6, r7, r11, r12, conflict, scope };
}

// ── Pontimpo's own figures (the analytics ground truth) ──────────────────
async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${process.env.PONTIMPO_API_URL}/api/v1${path}`, { headers: { Authorization: `Bearer ${process.env.PONTIMPO_API_KEY}` } });
  if (res.status !== 200) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}
interface Summary { metrics: { sales: { gross_centavos: number; net_centavos: number; iva_win_centavos: number } } }
interface Collected { collected_centavos: number; by_method: { method: string; amount_centavos: number }[] }
interface Debtors { summary: { total_debt_centavos: number; debtor_count: number }; data: { local_id: number; name: string; debt_centavos: number }[] }

const BA = 'America/Argentina/Buenos_Aires';
const baToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: BA }).format(new Date());
/** Monday of the current BA week (ISO week: "esta semana" = lunes → hoy). */
const baMonday = () => {
  const t = new Date(`${baToday()}T12:00:00Z`);
  return new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
};
/** "en octubre" = the most recent October that has started. */
const lastOctober = () => {
  const [y, m] = baToday().split('-').map(Number);
  const year = m >= 10 ? y : y - 1;
  return { from: `${year}-10-01`, to: `${year}-10-31` };
};
/** "$ 37.316.660,00" with every kind of space removed, for substring checks. */
const money = (c: number) => formatCentavos(c).replace(/\s/g, '');
const squash = (s: string) => s.replace(/\s/g, '');

const evidence: Record<string, unknown> = {};
const ids = (d: Awaited<ReturnType<typeof delta>>) => ({
  ledger: d.ledger.map((r) => r.id), cash: d.cash.map((r) => r.id), stock: d.stock.map((r) => r.id), audit: d.audit.map((r) => r.id),
});
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe.skipIf(!LIVE)('S6 live — seven recipes, analytics and hard paths on a migrated-data copy', () => {
  let processInbound: typeof import('@/lib/agent/process').processInbound;
  let store: ReturnType<typeof import('@/lib/session/store').getSessionStore>;
  let kapso: KapsoStub;
  let agentId: number;
  let STAFF: { staffName: string; onBehalfOf: string };
  let T: Targets;

  beforeAll(async () => {
    for (const n of ['PONTIMPO_API_URL', 'PONTIMPO_API_KEY', 'PONTIMPO_DEV_FIXTURE_KEY', 'PONTIMPO_DEV_VERIFY_DATABASE_URL', 'DATABASE_URL']) {
      if (!process.env[n]) throw new Error(`${n} missing — see the dev env file`);
    }
    // Local copies of the migrated data only, never anything remote.
    const verify = new URL(process.env.PONTIMPO_DEV_VERIFY_DATABASE_URL!);
    const ro = new URL(process.env.DATABASE_URL!);
    if (verify.hostname !== 'localhost' || !/^\/pontimpo_(dev|s6live)$/.test(verify.pathname)) throw new Error('dev target must be a local pontimpo_dev / pontimpo_s6live');
    if (ro.hostname !== 'localhost' || ro.pathname !== verify.pathname) throw new Error('agent SQL must read the same local database');
    if (ro.username !== 'pontimpo_agent_ro') throw new Error('agent SQL must run as pontimpo_agent_ro');
    if (new URL(process.env.PONTIMPO_API_URL!).hostname !== 'localhost') throw new Error('PONTIMPO_API_URL must be local');
    STAFF = JSON.parse(process.env.STAFF_ALLOWLIST!)[FROM];
    pool = new Pool({ connectionString: process.env.PONTIMPO_DEV_VERIFY_DATABASE_URL, max: 2 });
    ({ processInbound } = await import('@/lib/agent/process'));
    store = (await import('@/lib/session/store')).getSessionStore();
    kapso = await startKapsoStub();
    // The agent credential = the row whose hash is the key's (the app's own sha256 scheme).
    const keyHash = createHash('sha256').update(process.env.PONTIMPO_API_KEY!).digest('hex');
    [{ id: agentId }] = await q<{ id: number }>('SELECT id::int FROM api_credential WHERE key_hash = $1 AND is_active', [keyHash]);
    // …and the app on PONTIMPO_API_URL accepts it, so app and verification read the same database.
    await apiGet('/clients?limit=1');
    T = await pickTargets();
    evidence.database = verify.pathname.slice(1);
    evidence.agentCredentialId = agentId;
    evidence.onBehalfOf = STAFF.onBehalfOf;
    evidence.targets = { ...T, r4: { ...T.r4, name: undefined } }; // no customer names in the evidence file
  });
  afterAll(async () => {
    evidence.modelCalls = h.modelCalls;
    evidence.agentTurns = h.turns;
    evidence.usage = h.usage;
    console.log('[s6-evidence]', JSON.stringify({ ...evidence, usage: undefined }));
    if (process.env.S6_EVIDENCE_FILE) writeFileSync(process.env.S6_EVIDENCE_FILE, JSON.stringify(evidence, null, 2));
    await kapso?.close();
    await pool?.end();
  });
  beforeEach(async () => {
    harness.reset();
    kapso.reset();
    await store.setThread(FROM, { history: [], pending: null });
  });

  const agentRow = () => ({ credential_id: agentId, user_id: null });
  const byAgent = (action: string, obo: string | null) =>
    expect.objectContaining({ action, actor_type: 'agent', credential_id: agentId, on_behalf_of: obo });

  /** Message → a staged plan with Confirmar/Cancelar (nothing mutated yet). */
  async function plan(message: string) {
    await processInbound(text(message));
    const reply = kapso.lastReply();
    expect(reply.buttons, `expected a plan to confirm, got: ${reply.text}`).toBe(true);
    const pending = (await store.getThread(FROM)).pending!;
    expect(pending.steps.length).toBeGreaterThan(0);
    return { text: reply.text, pending };
  }
  async function confirm() {
    await processInbound(tap('confirm'));
    return kapso.lastReply().text;
  }
  async function correct(message: string) {
    const m = await marks();
    const p = await plan(message);
    expect((await delta(m)).ledger, 'planning must not mutate').toEqual([]);
    const done = await confirm();
    expect(done, done).toMatch(/^Listo\./);
    const d = await delta(m);
    return { ...p, done, d };
  }

  // ── R2 + webhook redelivery + idempotency replay / conflict ─────────────
  it('R2 — full payment; Confirmar redelivered twice via the webhook → applied once; replay + IDEMPOTENCY_CONFLICT', async () => {
    const t = T.r2;
    const { POST } = await import('@/app/api/webhooks/kapso/route');
    const { executePendingAction } = await import('@/lib/agent/execute');
    const { apiPost, PontimpoApiError } = await import('@/lib/pontimpo/client');
    const m = await marks();
    const { text: planText, pending } = await plan(`Registrá el pago total de la venta ${t.localId} en efectivo.`);
    expect(pending.steps.map((s) => s.call)).toEqual(['registerSalePayment']);
    expect(pending.steps[0].body).toMatchObject({ on_behalf_of: STAFF.onBehalfOf });

    const raw = JSON.stringify({
      message: { id: `wamid.dev-${randomUUID()}`, from: FROM, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'confirm', title: 'Confirmar' } } },
      phone_number_id: process.env.KAPSO_PHONE_NUMBER_ID,
    });
    const headers = {
      'content-type': 'application/json',
      'x-webhook-signature': createHmac('sha256', process.env.KAPSO_WEBHOOK_SECRET!).update(raw, 'utf8').digest('hex'),
      'x-idempotency-key': `dev-live-r2-${randomUUID()}`,
    };
    const deliver = () => POST(new Request('http://localhost/api/webhooks/kapso', { method: 'POST', headers, body: raw }) as never);
    const first = await deliver();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    await Promise.all(h.background.splice(0));
    const second = await deliver(); // Kapso redelivery, same X-Idempotency-Key
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ duplicate: true });
    await Promise.all(h.background.splice(0));
    expect(kapso.lastReply().text).toMatch(/^Listo\./);

    const d = await delta(m);
    expect(d.ledger).toEqual([expect.objectContaining({ kind: 'payment', amount: -t.total, payment_method: 'efectivo', currency: 'ARS', sale_id: t.saleId, client_id: t.clientId, ...agentRow(), on_behalf_of: STAFF.onBehalfOf })]);
    expect(d.ledger[0].description).toContain(STAFF.staffName);
    expect(d.cash).toEqual([expect.objectContaining({ kind: 'payment_received', method: 'efectivo', amount: t.total, ledger_entry_id: d.ledger[0].id })]);
    expect(d.stock).toEqual([]);
    expect(d.audit).toEqual([byAgent('sale.payment_registered', STAFF.onBehalfOf)]);
    expect(await sale(t.saleId)).toEqual({ status: 'paid', total: t.total });

    // Replaying the confirmed action (same keys, same bodies) → stored responses, nothing new.
    const replay = await executePendingAction(pending);
    expect(replay.ok).toBe(true);
    expect(replay.message).toContain('(ya estaba hecho)');
    // Same key, different body → IDEMPOTENCY_CONFLICT, in Spanish, nothing applied.
    const step = pending.steps[0];
    const err = await apiPost(step.path, { ...step.body, description: `${String(step.body.description)} (otro)` }, step.idempotencyKey).catch((e) => e);
    expect(PontimpoApiError.is(err)).toBe(true);
    expect(err).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409, userMessage: 'Solicitud repetida con datos diferentes' });
    expect(ids(await delta(m))).toEqual(ids(d));

    evidence.r2 = { sale: t, plan: flat(planText), ...ids(d), onBehalfOf: { ledger: d.ledger[0].on_behalf_of, audit: d.audit[0].on_behalf_of }, webhookFirst: 200, webhookRedelivery: 'duplicate', replay: replay.message, idempotencyConflict: err.code };
  });

  it('R4 — client-level USD payment: US$100 @ 1.485,00 → $148.500,00 (es-AR round-trip)', async () => {
    const t = T.r4;
    const debtOf = async () => (await q<{ debt: number }>('SELECT sum(amount_centavos)::float8 AS debt FROM client_ledger_entry WHERE client_id = $1', [t.clientId]))[0].debt;
    const before = await debtOf();
    const r = await correct(`${t.name} (cliente número ${t.localId}) dejó US$100 en efectivo a cuenta, a una cotización de $1.485. Registralo como pago a cuenta del cliente, sin venta.`);
    expect(r.pending.steps.map((s) => s.call)).toEqual(['registerClientPayment']);
    expect(r.pending.steps[0].body).toMatchObject({ currency: 'USD', amount_usd_centavos: 10_000, fx_rate_centavos: 148_500, payment_method: 'efectivo', on_behalf_of: STAFF.onBehalfOf });
    expect(flat(r.text)).toMatch(/US\$ 100,00 @ 1\.485,00 ≈ \$ 148\.500,00/);
    expect(r.d.ledger).toEqual([expect.objectContaining({ kind: 'payment', amount: -14_850_000, currency: 'USD', usd: 10_000, fx: 148_500, payment_method: 'efectivo', sale_id: null, client_id: t.clientId, ...agentRow(), on_behalf_of: STAFF.onBehalfOf })]);
    expect(r.d.cash).toEqual([expect.objectContaining({ kind: 'payment_received', method: 'efectivo', amount: 14_850_000, currency: 'USD', usd: 10_000, fx: 148_500, ledger_entry_id: r.d.ledger[0].id })]);
    expect(r.d.stock).toEqual([]);
    expect(r.d.audit).toEqual([byAgent('client.payment_registered', STAFF.onBehalfOf)]);
    const after = await debtOf();
    expect(after).toBe(before - 14_850_000);
    evidence.r4 = { client: { clientId: t.clientId, localId: t.localId }, plan: flat(r.text).replace(t.name, '<cliente>'), debtBefore: before, debtAfter: after, ...ids(r.d), onBehalfOf: { ledger: r.d.ledger[0].on_behalf_of, audit: r.d.audit[0].on_behalf_of } };
  });

  it('R5 — cancel an unpaid sale: cancellation entry, stock back, status cancelled', async () => {
    const t = T.r5;
    const stockBefore = await stockOf(t.productId);
    const r = await correct(`Anulá la venta ${t.localId}, la cargué por error.`);
    expect(r.pending.steps.map((s) => s.call)).toEqual(['cancelSale']);
    expect(r.d.ledger).toEqual([expect.objectContaining({ kind: 'cancellation', amount: -t.total, sale_id: t.saleId, ...agentRow(), on_behalf_of: STAFF.onBehalfOf })]);
    expect(r.d.cash).toEqual([]);
    expect(r.d.stock).toEqual([expect.objectContaining({ product_id: t.productId, kind: 'sale_reverted', delta: t.qty, sale_item_id: t.itemId })]);
    expect(r.d.audit).toEqual([byAgent('sale.cancelled', STAFF.onBehalfOf)]);
    expect(await stockOf(t.productId)).toBe(stockBefore + t.qty);
    expect((await sale(t.saleId)).status).toBe('cancelled');
    evidence.r5 = { sale: t, plan: flat(r.text), stockBefore, stockAfter: stockBefore + t.qty, ...ids(r.d) };
  });

  it('R6 — refund a paid sale in cash with restock: cancellation + refund, cash out, stock back', async () => {
    const t = T.r6;
    const stockBefore = await stockOf(t.productId);
    const r = await correct(`Reembolsá la venta ${t.localId} en efectivo: el cliente devolvió todo y vuelve al stock.`);
    expect(r.pending.steps.map((s) => s.call)).toEqual(['refundSale']);
    const obo = { ...agentRow(), on_behalf_of: STAFF.onBehalfOf, sale_id: t.saleId };
    expect(r.d.ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'cancellation', amount: -t.total, ...obo }),
      expect.objectContaining({ kind: 'refund', amount: t.total, payment_method: 'efectivo', ...obo }),
    ]));
    expect(r.d.ledger).toHaveLength(2);
    expect(r.d.cash).toEqual([expect.objectContaining({ kind: 'refund', method: 'efectivo', amount: -t.total })]);
    expect(r.d.stock).toEqual([expect.objectContaining({ product_id: t.productId, kind: 'sale_reverted', delta: t.qty, sale_item_id: t.itemId })]);
    expect(r.d.audit).toEqual([byAgent('sale.refunded', STAFF.onBehalfOf)]);
    expect(r.d.ledger.reduce((a, e) => a + e.amount, 0)).toBe(0); // net 0
    expect((await sale(t.saleId)).status).toBe('refunded');
    expect(await stockOf(t.productId)).toBe(stockBefore + t.qty);
    evidence.r6 = { sale: t, plan: flat(r.text), stockBefore, stockAfter: stockBefore + t.qty, ...ids(r.d) };
  });

  it('R7 — correct a sale amount (+$10.000 per unit): prices, total, +delta adjustment', async () => {
    const t = T.r7;
    const newUnit = t.unit + 1_000_000;
    const newTotal = newUnit * t.qty;
    const r = await correct(`La venta ${t.localId} era de ${formatCentavos(newTotal)} y no de ${formatCentavos(t.total)}: las dos unidades iban a ${formatCentavos(newUnit)} cada una. Corregí el precio.`);
    expect(r.pending.steps.map((s) => s.call)).toEqual(['correctSaleAmount']);
    expect(r.pending.steps[0].body).toMatchObject({ expected_current_total_centavos: t.total, lines: [{ sale_item_id: t.itemId, unit_price_centavos: newUnit }] });
    expect(r.d.ledger).toEqual([expect.objectContaining({ kind: 'adjustment', amount: newTotal - t.total, sale_id: t.saleId, ...agentRow(), on_behalf_of: STAFF.onBehalfOf })]);
    expect(r.d.cash).toEqual([]);
    expect(r.d.stock).toEqual([]);
    expect(r.d.audit).toEqual([byAgent('sale.corrected', STAFF.onBehalfOf)]);
    expect(await sale(t.saleId)).toEqual({ status: 'pending', total: newTotal });
    expect((await items(t.saleId)).map((i) => [i.unit, i.total])).toEqual([[newUnit, newTotal]]);
    evidence.r7 = { sale: t, plan: flat(r.text), newTotal, ...ids(r.d) };
  });

  it('R11 + R2 ×4 — "la cobré toda en efectivo pero fueron 4 cheques"', async () => {
    const t = T.r11;
    const cheque = t.total / 4;
    const r = await correct(`La venta ${t.localId} la cobré toda en efectivo pero en realidad fueron 4 cheques de ${formatCentavos(cheque)} cada uno.`);
    expect(r.pending.steps.map((s) => s.call)).toEqual(['reversePayment', 'registerSalePayment', 'registerSalePayment', 'registerSalePayment', 'registerSalePayment']);
    const [rev, ...cheques] = r.d.ledger;
    expect(rev).toMatchObject({ kind: 'adjustment', amount: t.total, reverses_entry_id: t.paymentId, sale_id: t.saleId, ...agentRow(), on_behalf_of: STAFF.onBehalfOf });
    expect(cheques).toEqual(Array(4).fill(expect.objectContaining({ kind: 'payment', amount: -cheque, payment_method: 'cheque', sale_id: t.saleId, ...agentRow(), on_behalf_of: STAFF.onBehalfOf })));
    const [cashRev, ...cashCheques] = r.d.cash;
    expect(cashRev).toMatchObject({ kind: 'adjustment', method: 'efectivo', amount: -t.total, reverses_movement_id: t.cashId });
    expect(cashCheques).toEqual(cheques.map((c) => expect.objectContaining({ kind: 'payment_received', method: 'cheque', amount: cheque, ledger_entry_id: c.id })));
    expect(r.d.stock).toEqual([]);
    expect(r.d.audit).toEqual([byAgent('sale.payment_reversed', STAFF.onBehalfOf), ...Array(4).fill(byAgent('sale.payment_registered', STAFF.onBehalfOf))]);
    expect(await sale(t.saleId)).toEqual({ status: 'paid', total: t.total });
    expect(await debtOfSale(t.saleId)).toBe(0);
    evidence.r11 = { sale: t, plan: flat(r.text), originalCashMovement: t.cashId, ...ids(r.d), onBehalfOf: { cheques: cheques.map((c) => c.on_behalf_of), audit: r.d.audit.map((a) => a.on_behalf_of) } };
  });

  it('R12 — swap the wrong product (found via GET /products): stock fixed on both, zero ledger effect', async () => {
    const t = T.r12;
    const [a, b] = [await stockOf(t.productId), await stockOf(t.toId)];
    const r = await correct(`En la venta ${t.localId} cargué el producto código ${t.fromCode} (${t.fromDetails}) pero era el código ${t.toCode} (${t.toDetails}). Cambiá el producto y dejá el mismo precio.`);
    expect(harness.toolCalls).toContain('findProducts');
    expect(r.pending.steps.map((s) => s.call)).toEqual(['swapSaleLine']);
    expect(r.pending.steps[0].body).toMatchObject({ sale_item_id: t.itemId, new_product_id: t.toId, expected_current_total_centavos: t.total });
    expect(r.d.ledger).toEqual([]);
    expect(r.d.cash).toEqual([]);
    expect(r.d.stock).toEqual([
      expect.objectContaining({ product_id: t.productId, kind: 'sale_reverted', delta: t.qty, sale_item_id: t.itemId }),
      expect.objectContaining({ product_id: t.toId, kind: 'sale', delta: -t.qty, sale_item_id: t.itemId }),
    ]);
    expect(r.d.audit).toEqual([byAgent('sale.line_swapped', STAFF.onBehalfOf)]);
    expect([await stockOf(t.productId), await stockOf(t.toId)]).toEqual([a + t.qty, b - t.qty]);
    expect((await items(t.saleId)).map((i) => i.product_id)).toEqual([t.toId]);
    expect(await sale(t.saleId)).toMatchObject({ total: t.total });
    evidence.r12 = { sale: t, plan: flat(r.text), stockLevels: { [t.productId]: [a, a + t.qty], [t.toId]: [b, b - t.qty] }, ...ids(r.d) };
  });

  // ── Analytics over WhatsApp, checked against Pontimpo's own API ─────────
  /** A read-only question: a plain answer (no plan), from store-scoped SQL, nothing written. */
  async function ask(question: string) {
    const m = await marks();
    await processInbound(text(question));
    const reply = kapso.lastReply();
    expect(reply.buttons, reply.text).toBe(false);
    expect((await store.getThread(FROM)).pending).toBeNull();
    expect(harness.toolCalls.filter((t) => MUTATIONS.includes(t))).toEqual([]);
    const sqls = harness.toolInputs.filter((t) => t.name === 'executeSQL').map((t) => (t.input as { sql: string }).sql);
    expect(sqls.length, 'answered from the read-only SQL path').toBeGreaterThan(0);
    for (const s of sqls) expect(s, 'every query is store-scoped').toMatch(/store_id\s*=\s*1\b/);
    expect(await delta(m)).toEqual({ ledger: [], cash: [], stock: [], audit: [] });
    return { answer: reply.text, sqls: sqls.length };
  }
  const analytics: unknown[] = [];
  evidence.analytics = analytics;
  /** The API figure read right before and right after the question must agree (nothing moved). */
  async function stable<T>(read: () => Promise<T>, question: string) {
    const before = await read();
    const res = await ask(question);
    expect(await read(), 'figure moved while the agent answered').toEqual(before);
    return { ...res, api: before };
  }

  it('analytics — "¿Cuánto vendimos en octubre?" = /metrics/summary gross', async () => {
    const oct = lastOctober();
    const question = '¿Cuánto vendimos en octubre?';
    const r = await stable(async () => (await apiGet<Summary>(`/metrics/summary?from=${oct.from}&to=${oct.to}`)).metrics.sales.gross_centavos, question);
    expect(squash(r.answer), r.answer).toContain(money(r.api));
    analytics.push({ question, answer: flat(r.answer), api: { endpoint: `/metrics/summary?from=${oct.from}&to=${oct.to}`, gross_centavos: r.api, formatted: formatCentavos(r.api) }, sqlQueries: r.sqls });
  });

  it('analytics — ganancia neta + ganancia IVA de octubre = /metrics/summary net + iva_win', async () => {
    const oct = lastOctober();
    const question = '¿Cuál fue la ganancia neta de octubre? ¿Y cuánto fue la ganancia de IVA?';
    const r = await stable(async () => {
      const { metrics } = await apiGet<Summary>(`/metrics/summary?from=${oct.from}&to=${oct.to}`);
      return { net: metrics.sales.net_centavos, iva: metrics.sales.iva_win_centavos };
    }, question);
    expect(squash(r.answer), r.answer).toContain(money(r.api.net));
    expect(squash(r.answer), r.answer).toContain(money(r.api.iva));
    analytics.push({ question, answer: flat(r.answer), api: { endpoint: `/metrics/summary?from=${oct.from}&to=${oct.to}`, net_centavos: r.api.net, iva_win_centavos: r.api.iva, formatted: [formatCentavos(r.api.net), formatCentavos(r.api.iva)] }, sqlQueries: r.sqls });
  });

  it('analytics — "¿Cuánto se cobró en efectivo esta semana?" = /metrics/collected efectivo (lunes → hoy)', async () => {
    const [from, to] = [baMonday(), baToday()];
    const question = '¿Cuánto se cobró en efectivo esta semana?';
    const r = await stable(async () => {
      const c = await apiGet<Collected>(`/metrics/collected?from=${from}&to=${to}`);
      return c.by_method.find((x) => x.method === 'efectivo')?.amount_centavos ?? 0;
    }, question);
    expect(r.api).toBeGreaterThan(0);
    expect(squash(r.answer), r.answer).toContain(money(r.api));
    analytics.push({ question, answer: flat(r.answer), api: { endpoint: `/metrics/collected?from=${from}&to=${to}`, efectivo_centavos: r.api, formatted: formatCentavos(r.api) }, sqlQueries: r.sqls });
  });

  it('analytics — "¿Quiénes son los 5 que más deben?" = /debtors top 5, in order', async () => {
    const question = '¿Quiénes son los 5 clientes que más nos deben?';
    const r = await stable(async () => (await apiGet<Debtors>('/debtors?limit=5')).data.map((d) => ({ localId: d.local_id, name: d.name, debt: d.debt_centavos })), question);
    expect(r.api).toHaveLength(5);
    const answer = squash(r.answer);
    const at = r.api.map((d) => answer.indexOf(money(d.debt)));
    expect(at.every((i) => i >= 0), r.answer).toBe(true);
    expect([...at].sort((x, y) => x - y), 'same order as the debtors page').toEqual(at);
    for (const d of r.api) expect(answer.toLowerCase(), r.answer).toContain(squash(d.name).toLowerCase());
    analytics.push({ question, answer: '(customer names redacted) ' + r.api.reduce((s, d, i) => s.replace(d.name, `<deudor ${i + 1}>`), flat(r.answer)), api: { endpoint: '/debtors?limit=5', top5: r.api.map((d) => ({ localId: d.localId, debt_centavos: d.debt, formatted: formatCentavos(d.debt) })) }, sqlQueries: r.sqls });
  });

  it('analytics — deuda viva total + cantidad de deudores = /debtors summary', async () => {
    const question = '¿Cuánta deuda viva tenemos hoy en total y cuántos clientes nos deben?';
    const r = await stable(async () => {
      const { summary } = await apiGet<Debtors>('/debtors?limit=1');
      return { total: summary.total_debt_centavos, count: summary.debtor_count };
    }, question);
    expect(squash(r.answer), r.answer).toContain(money(r.api.total));
    expect(r.answer).toMatch(new RegExp(`\\b${r.api.count}\\b`));
    analytics.push({ question, answer: flat(r.answer), api: { endpoint: '/debtors', total_debt_centavos: r.api.total, debtor_count: r.api.count, formatted: formatCentavos(r.api.total) }, sqlQueries: r.sqls });
  });

  // ── Hard paths ───────────────────────────────────────────────────────────
  it('CONFLICT — sale changed between plan and confirm → Spanish CONFLICT, nothing applied → clean re-plan', async () => {
    const t = T.conflict;
    const theirs = t.unit + 100_000; // someone else's correction: +$1.000
    const ours = t.unit + 300_000; // what the staff wants: +$3.000
    const m = await marks();
    const first = await plan(`La venta ${t.localId} era de ${formatCentavos(ours)} y no de ${formatCentavos(t.total)}, corregí el precio.`);
    expect(first.pending.steps[0].expectedTotalSnapshot).toBe(t.total);

    // Someone else corrects it first (the harness credential, not the agent).
    const res = await fetch(`${process.env.PONTIMPO_API_URL}/api/v1/sales/${t.saleId}/corrections`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.PONTIMPO_DEV_FIXTURE_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `dev-live-fixture-${randomUUID()}` },
      body: JSON.stringify({ expected_current_total_centavos: t.total, lines: [{ sale_item_id: t.itemId, unit_price_centavos: theirs }], reason: 'S6 harness: cambio concurrente', on_behalf_of: 's6-harness' }),
    });
    expect(res.status).toBe(200);
    const interference = await delta(m);

    const refused = await confirm();
    expect(refused).toMatch(/No pude aplicar la corrección/);
    expect(refused).toContain('El registro fue modificado por otra persona, recarga e intenta de nuevo');
    expect(ids(await delta(m)), 'the stale plan applied nothing').toEqual(ids(interference));
    expect((await store.getThread(FROM)).pending).toBeNull();

    const m2 = await marks();
    const again = await plan(`Ya lo revisé: la venta ${t.localId} tiene que quedar en ${formatCentavos(ours)}. Corregila de nuevo con los datos actuales.`);
    expect(again.pending.steps[0].expectedTotalSnapshot).toBe(theirs);
    const done = await confirm();
    expect(done).toMatch(/^Listo\./);
    const d = await delta(m2);
    expect(d.ledger).toEqual([expect.objectContaining({ kind: 'adjustment', amount: ours - theirs, ...agentRow(), on_behalf_of: STAFF.onBehalfOf })]);
    expect(d.audit).toEqual([byAgent('sale.corrected', STAFF.onBehalfOf)]);
    expect(await sale(t.saleId)).toEqual({ status: 'pending', total: ours });
    evidence.conflict = { sale: t, firstPlan: flat(first.text), interference: ids(interference), refused: flat(refused), replan: flat(again.text), ...ids(d) };
  });

  it('scope — a write the credential lacks (product price) → Spanish refusal, no plan, no mutation, no SQL', async () => {
    const t = T.scope;
    const m = await marks();
    await processInbound(text(`Cambiá el precio del producto código ${t.code} a ${formatCentavos(t.price + 100_000)} en el catálogo.`));
    const reply = kapso.lastReply();
    expect(reply.buttons).toBe(false);
    expect((await store.getThread(FROM)).pending).toBeNull();
    expect(harness.toolCalls.filter((c) => MUTATIONS.includes(c) || c === 'executeSQL')).toEqual([]);
    expect(reply.text).toMatch(/no puedo|no tengo (permiso|acceso)|fuera de (mi|lo que)|no está a mi alcance/i);
    expect(await delta(m)).toEqual({ ledger: [], cash: [], stock: [], audit: [] });
    expect((await q<{ price: number }>('SELECT price_centavos::float8 AS price FROM product WHERE id = $1', [t.productId]))[0].price).toBe(t.price);

    // And the API itself refuses those writes for this credential, in Spanish.
    const post = (path: string, body: unknown) => fetch(`${process.env.PONTIMPO_API_URL}/api/v1${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.PONTIMPO_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `dev-live-scope-${randomUUID()}` },
      body: JSON.stringify(body),
    });
    const createSale = await post('/sales', { client_id: T.r4.clientId, lines: [{ product_id: t.productId, quantity: 1 }] });
    const stockAdj = await post(`/products/${t.productId}/stock-adjustments`, { quantity_delta: 1, reason: 'x' });
    const api = { createSale: [createSale.status, await createSale.json()], stockAdjustment: [stockAdj.status, await stockAdj.json()] };
    expect(api.createSale).toEqual([403, { code: 'SALE_COUNTER_ONLY', message: 'Las ventas se cargan solo desde el mostrador: un agente no puede crear ventas' }]);
    expect(api.stockAdjustment).toEqual([403, { code: 'FORBIDDEN', message: 'No tienes permiso para realizar esta acción' }]);
    expect(await delta(m)).toEqual({ ledger: [], cash: [], stock: [], audit: [] });
    evidence.scope = { reply: flat(reply.text), toolCalls: [...harness.toolCalls], api };
  });

  it('allowlist — an unknown number is refused in Spanish with zero model and zero tool calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const calls = h.modelCalls;
    const m = await marks();
    try {
      await processInbound(text(`Anulá la venta ${T.r5.localId}, fue un error.`, STRANGER));
      expect(h.modelCalls - calls).toBe(0);
      expect(harness.toolCalls).toEqual([]);
      const nonKapso = fetchSpy.mock.calls.filter(([u]) => !String(u instanceof Request ? u.url : u).startsWith(process.env.KAPSO_BASE_URL!));
      expect(nonKapso).toEqual([]);
      expect(kapso.sent).toHaveLength(1);
      expect(kapso.lastReply().raw.body.to).toBe(STRANGER);
      expect(kapso.lastReply().text).toMatch(/no puedo atender este número/);
      expect(await delta(m)).toEqual({ ledger: [], cash: [], stock: [], audit: [] });
      evidence.allowlist = { reply: kapso.lastReply().text, modelCalls: 0, toolCalls: 0 };
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('webhook — bad signature → 401, nothing processed', async () => {
    const { POST } = await import('@/app/api/webhooks/kapso/route');
    const raw = JSON.stringify({ message: { id: `wamid.dev-${randomUUID()}`, from: FROM, type: 'text', text: { body: 'anulá la venta 1' } } });
    const bad = createHmac('sha256', 'not-the-secret').update(raw, 'utf8').digest('hex');
    const calls = h.modelCalls;
    const res = await POST(new Request('http://localhost/api/webhooks/kapso', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-signature': bad }, body: raw }) as never);
    expect(res.status).toBe(401);
    expect(h.background).toEqual([]);
    expect(h.modelCalls).toBe(calls);
    expect(kapso.sent).toEqual([]);
    evidence.badSignature = res.status;
  });

  it('afterwards: pontimpo `pnpm reconcile` on the target database exits 0', () => {
    const run = spawnSync('pnpm', ['reconcile'], {
      cwd: new URL('../../../pontimpo-tire-system', import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: process.env.PONTIMPO_DEV_VERIFY_DATABASE_URL },
      encoding: 'utf8',
    });
    evidence.reconcile = { status: run.status, tail: run.stdout.trim().split('\n').slice(-12) };
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });
});
