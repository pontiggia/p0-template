// S6 live run against the LOCAL pontimpo_dev — migrated real data, the
// Pontimpo app on :3201, the Phase-1 credential minted through the app's own
// service, the REAL agent loop (Anthropic). Kapso is the local stub; the
// allowlist maps a fake number to a real Las Flores admin (on_behalf_of).
//
//   PONTIMPO_TARGET=dev ANTHROPIC_API_KEY=… pnpm test:live
//
// For each mutating recipe it asserts EVERY row the recipe wrote to store 1
// (ledger, cash, stock, audit — captured as the delta past a watermark) against
// DOMAIN_SPEC §3, then the hard paths. The records are real sales/clients picked
// for their shape (see FX below); the run mutates them, so it is one-shot per
// pontimpo_dev snapshot. Evidence ids go to $S6_EVIDENCE_FILE when set.
import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

/** Real pontimpo_dev (store 1, Las Flores) records, picked for their shape. */
const FX = {
  r2: { saleId: 4885, localId: 4922, clientId: 175 },               // pending $15.000, 2× CAMARA MOTO, no payments
  r4: { clientId: 182, localId: 183 }, // debtor $320.900 (name read at run time — no customer names in the repo)
  r5: { saleId: 4853, localId: 4890, clientId: 1031, productId: 727, itemId: 4853 }, // pending $190.000, 1× CAMARA AGRICOLA
  r6: { saleId: 4870, localId: 4907, clientId: 1411, productId: 733, itemId: 4870 }, // paid $35.000 efectivo, 1× CAMARA AGRICOLA
  r7: { saleId: 4809, localId: 4846, clientId: 1349, itemId: 4809 }, // pending 2× $105.000 = $210.000
  // paid $60.000 in one efectivo payment. (The first run used sale 4880 / #4917 — reversed + 4 cheques
  // applied correctly, ledger 12034–12038; only this test's own debt helper was wrong. Re-run on a fresh sale.)
  r11: { saleId: 4863, localId: 4900, clientId: 860, paymentId: 11781 },
  r12: { saleId: 4833, localId: 4870, clientId: 56, itemId: 4833, from: 515, to: 473 }, // 2× DOUBLE COIN 215/80 16 → FORTUNE 235/50 19 (1245), both $235.000
  conflict: { saleId: 4780, localId: 4817, clientId: 1271, itemId: 4780 }, // pending 1× $49.000
  scope: { productId: 540, code: '32' }, // CAMARA MOTO $6.600
} as const;

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

const evidence: Record<string, unknown> = {};
const ids = (d: Awaited<ReturnType<typeof delta>>) => ({
  ledger: d.ledger.map((r) => r.id), cash: d.cash.map((r) => r.id), stock: d.stock.map((r) => r.id), audit: d.audit.map((r) => r.id),
});
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe.skipIf(!LIVE)('S6 live — seven recipes + hard paths on migrated pontimpo_dev', () => {
  let processInbound: typeof import('@/lib/agent/process').processInbound;
  let store: ReturnType<typeof import('@/lib/session/store').getSessionStore>;
  let kapso: KapsoStub;
  let agentId: number;
  let STAFF: { staffName: string; onBehalfOf: string };

  beforeAll(async () => {
    for (const n of ['PONTIMPO_API_URL', 'PONTIMPO_API_KEY', 'PONTIMPO_DEV_FIXTURE_KEY', 'PONTIMPO_DEV_VERIFY_DATABASE_URL', 'DATABASE_URL']) {
      if (!process.env[n]) throw new Error(`${n} missing — see .env.dev-live.local`);
    }
    if (new URL(process.env.PONTIMPO_DEV_VERIFY_DATABASE_URL!).pathname !== '/pontimpo_dev') throw new Error('dev target must be pontimpo_dev');
    if (new URL(process.env.DATABASE_URL!).username !== 'pontimpo_agent_ro') throw new Error('agent SQL must run as pontimpo_agent_ro');
    STAFF = JSON.parse(process.env.STAFF_ALLOWLIST!)[FROM];
    pool = new Pool({ connectionString: process.env.PONTIMPO_DEV_VERIFY_DATABASE_URL, max: 2 });
    ({ processInbound } = await import('@/lib/agent/process'));
    store = (await import('@/lib/session/store')).getSessionStore();
    kapso = await startKapsoStub();
    [{ id: agentId }] = await q<{ id: number }>("SELECT id::int FROM api_credential WHERE name = 'S6 dev — agente WhatsApp (Phase-1)' AND is_active");
    evidence.agentCredentialId = agentId;
    evidence.onBehalfOf = STAFF.onBehalfOf;
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
    const { POST } = await import('@/app/api/webhooks/kapso/route');
    const { executePendingAction } = await import('@/lib/agent/execute');
    const { apiPost, PontimpoApiError } = await import('@/lib/pontimpo/client');
    const m = await marks();
    const { text: planText, pending } = await plan(`Registrá el pago total de la venta ${FX.r2.localId} en efectivo.`);
    expect(pending.steps.map((s) => s.call)).toEqual(['registerSalePayment']);

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
    expect(d.ledger).toEqual([expect.objectContaining({ kind: 'payment', amount: -1_500_000, payment_method: 'efectivo', currency: 'ARS', sale_id: FX.r2.saleId, client_id: FX.r2.clientId, ...agentRow(), on_behalf_of: null })]);
    expect(d.ledger[0].description).toContain(STAFF.staffName); // R2 has no on_behalf_of in the contract; attribution rides here
    expect(d.cash).toEqual([expect.objectContaining({ kind: 'payment_received', method: 'efectivo', amount: 1_500_000, ledger_entry_id: d.ledger[0].id })]);
    expect(d.stock).toEqual([]);
    expect(d.audit).toEqual([byAgent('sale.payment_registered', null)]);
    expect(await sale(FX.r2.saleId)).toEqual({ status: 'paid', total: 1_500_000 });

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

    evidence.r2 = { sale: FX.r2, plan: flat(planText), ...ids(d), webhookFirst: 200, webhookRedelivery: 'duplicate', replay: replay.message, idempotencyConflict: err.code };
  });

  it('R4 — client-level USD payment: US$100 @ 1.485,00 → $148.500,00 (es-AR round-trip)', async () => {
    const before = await q<{ debt: number }>('SELECT sum(amount_centavos)::int AS debt FROM client_ledger_entry WHERE client_id = $1', [FX.r4.clientId]);
    const [{ name }] = await q<{ name: string }>('SELECT name FROM client WHERE id = $1', [FX.r4.clientId]);
    const r = await correct(`${name} (cliente número ${FX.r4.localId}) dejó US$100 en efectivo a cuenta, a una cotización de $1.485. Registralo como pago a cuenta del cliente, sin venta.`);
    expect(r.pending.steps.map((s) => s.call)).toEqual(['registerClientPayment']);
    expect(r.pending.steps[0].body).toMatchObject({ currency: 'USD', amount_usd_centavos: 10_000, fx_rate_centavos: 148_500, payment_method: 'efectivo' });
    expect(flat(r.text)).toMatch(/US\$ 100,00 @ 1\.485,00 ≈ \$ 148\.500,00/);
    expect(r.d.ledger).toEqual([expect.objectContaining({ kind: 'payment', amount: -14_850_000, currency: 'USD', usd: 10_000, fx: 148_500, payment_method: 'efectivo', sale_id: null, client_id: FX.r4.clientId, ...agentRow(), on_behalf_of: null })]);
    expect(r.d.cash).toEqual([expect.objectContaining({ kind: 'payment_received', method: 'efectivo', amount: 14_850_000, currency: 'USD', usd: 10_000, fx: 148_500, ledger_entry_id: r.d.ledger[0].id })]);
    expect(r.d.stock).toEqual([]);
    expect(r.d.audit).toEqual([byAgent('client.payment_registered', null)]);
    const after = await q<{ debt: number }>('SELECT sum(amount_centavos)::int AS debt FROM client_ledger_entry WHERE client_id = $1', [FX.r4.clientId]);
    expect(after[0].debt).toBe(before[0].debt - 14_850_000);
    evidence.r4 = { client: FX.r4, plan: flat(r.text), debtBefore: before[0].debt, debtAfter: after[0].debt, ...ids(r.d) };
  });

  it('R5 — cancel an unpaid sale: cancellation entry, stock back, status cancelled', async () => {
    const stockBefore = await stockOf(FX.r5.productId);
    const r = await correct(`Anulá la venta ${FX.r5.localId}, la cargué por error.`);
    expect(r.pending.steps.map((s) => s.call)).toEqual(['cancelSale']);
    expect(r.d.ledger).toEqual([expect.objectContaining({ kind: 'cancellation', amount: -19_000_000, sale_id: FX.r5.saleId, ...agentRow(), on_behalf_of: STAFF.onBehalfOf })]);
    expect(r.d.cash).toEqual([]);
    expect(r.d.stock).toEqual([expect.objectContaining({ product_id: FX.r5.productId, kind: 'sale_reverted', delta: 1, sale_item_id: FX.r5.itemId })]);
    expect(r.d.audit).toEqual([byAgent('sale.cancelled', STAFF.onBehalfOf)]);
    expect(await stockOf(FX.r5.productId)).toBe(stockBefore + 1);
    expect((await sale(FX.r5.saleId)).status).toBe('cancelled');
    evidence.r5 = { sale: FX.r5, plan: flat(r.text), stockBefore, stockAfter: stockBefore + 1, ...ids(r.d) };
  });

  it('R6 — refund a paid sale in cash with restock: cancellation + refund, cash out, stock back', async () => {
    const stockBefore = await stockOf(FX.r6.productId);
    const r = await correct(`Reembolsá la venta ${FX.r6.localId} en efectivo: el cliente devolvió la cámara y vuelve al stock.`);
    expect(r.pending.steps.map((s) => s.call)).toEqual(['refundSale']);
    const obo = { ...agentRow(), on_behalf_of: STAFF.onBehalfOf, sale_id: FX.r6.saleId };
    expect(r.d.ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'cancellation', amount: -3_500_000, ...obo }),
      expect.objectContaining({ kind: 'refund', amount: 3_500_000, payment_method: 'efectivo', ...obo }),
    ]));
    expect(r.d.ledger).toHaveLength(2);
    expect(r.d.cash).toEqual([expect.objectContaining({ kind: 'refund', method: 'efectivo', amount: -3_500_000 })]);
    expect(r.d.stock).toEqual([expect.objectContaining({ product_id: FX.r6.productId, kind: 'sale_reverted', delta: 1, sale_item_id: FX.r6.itemId })]);
    expect(r.d.audit).toEqual([byAgent('sale.refunded', STAFF.onBehalfOf)]);
    expect(r.d.ledger.reduce((a, e) => a + e.amount, 0)).toBe(-3_500_000 + 3_500_000); // net 0
    expect((await sale(FX.r6.saleId)).status).toBe('refunded');
    expect(await stockOf(FX.r6.productId)).toBe(stockBefore + 1);
    evidence.r6 = { sale: FX.r6, plan: flat(r.text), stockBefore, stockAfter: stockBefore + 1, ...ids(r.d) };
  });

  it('R7 — correct a sale amount ($210.000 → $230.000): prices, total, +delta adjustment', async () => {
    const r = await correct(`La venta ${FX.r7.localId} era de $230.000 y no de $210.000: las dos cubiertas iban a $115.000 cada una. Corregí el precio.`);
    expect(r.pending.steps.map((s) => s.call)).toEqual(['correctSaleAmount']);
    expect(r.pending.steps[0].body).toMatchObject({ expected_current_total_centavos: 21_000_000, lines: [{ sale_item_id: FX.r7.itemId, unit_price_centavos: 11_500_000 }] });
    expect(r.d.ledger).toEqual([expect.objectContaining({ kind: 'adjustment', amount: 2_000_000, sale_id: FX.r7.saleId, ...agentRow(), on_behalf_of: STAFF.onBehalfOf })]);
    expect(r.d.cash).toEqual([]);
    expect(r.d.stock).toEqual([]);
    expect(r.d.audit).toEqual([byAgent('sale.corrected', STAFF.onBehalfOf)]);
    expect(await sale(FX.r7.saleId)).toEqual({ status: 'pending', total: 23_000_000 });
    expect((await items(FX.r7.saleId)).map((i) => [i.unit, i.total])).toEqual([[11_500_000, 23_000_000]]);
    evidence.r7 = { sale: FX.r7, plan: flat(r.text), ...ids(r.d) };
  });

  it('R11 + R2 ×4 — "la cobré toda en efectivo pero fueron 4 cheques"', async () => {
    const [orig] = await q<{ id: number }>('SELECT id::int FROM cash_movement WHERE ledger_entry_id = $1', [FX.r11.paymentId]);
    const r = await correct(`La venta ${FX.r11.localId} la cobré toda en efectivo pero en realidad fueron 4 cheques de $15.000 cada uno.`);
    expect(r.pending.steps.map((s) => s.call)).toEqual(['reversePayment', 'registerSalePayment', 'registerSalePayment', 'registerSalePayment', 'registerSalePayment']);
    const [rev, ...cheques] = r.d.ledger;
    expect(rev).toMatchObject({ kind: 'adjustment', amount: 6_000_000, reverses_entry_id: FX.r11.paymentId, sale_id: FX.r11.saleId, ...agentRow(), on_behalf_of: STAFF.onBehalfOf });
    expect(cheques).toEqual(Array(4).fill(expect.objectContaining({ kind: 'payment', amount: -1_500_000, payment_method: 'cheque', sale_id: FX.r11.saleId, ...agentRow(), on_behalf_of: null })));
    const [cashRev, ...cashCheques] = r.d.cash;
    expect(cashRev).toMatchObject({ kind: 'adjustment', method: 'efectivo', amount: -6_000_000, reverses_movement_id: orig.id });
    expect(cashCheques).toEqual(cheques.map((c) => expect.objectContaining({ kind: 'payment_received', method: 'cheque', amount: 1_500_000, ledger_entry_id: c.id })));
    expect(r.d.stock).toEqual([]);
    expect(r.d.audit).toEqual([byAgent('sale.payment_reversed', STAFF.onBehalfOf), ...Array(4).fill(byAgent('sale.payment_registered', null))]);
    expect(await sale(FX.r11.saleId)).toEqual({ status: 'paid', total: 6_000_000 });
    expect(await debtOfSale(FX.r11.saleId)).toBe(0);
    evidence.r11 = { sale: FX.r11, plan: flat(r.text), originalCashMovement: orig.id, ...ids(r.d) };
  });

  it('R12 — swap the wrong product (found via GET /products): stock fixed on both, zero ledger effect', async () => {
    const [a, b] = [await stockOf(FX.r12.from), await stockOf(FX.r12.to)];
    const r = await correct(`En la venta ${FX.r12.localId} cargué la Double Coin 215/80 16 pero era la Fortune 235/50 19 (código 1245). Cambiá el producto y dejá el mismo precio.`);
    expect(harness.toolCalls).toContain('findProducts');
    expect(r.pending.steps.map((s) => s.call)).toEqual(['swapSaleLine']);
    expect(r.pending.steps[0].body).toMatchObject({ sale_item_id: FX.r12.itemId, new_product_id: FX.r12.to, expected_current_total_centavos: 47_000_000 });
    expect(r.d.ledger).toEqual([]);
    expect(r.d.cash).toEqual([]);
    expect(r.d.stock).toEqual([
      expect.objectContaining({ product_id: FX.r12.from, kind: 'sale_reverted', delta: 2, sale_item_id: FX.r12.itemId }),
      expect.objectContaining({ product_id: FX.r12.to, kind: 'sale', delta: -2, sale_item_id: FX.r12.itemId }),
    ]);
    expect(r.d.audit).toEqual([byAgent('sale.line_swapped', STAFF.onBehalfOf)]);
    expect([await stockOf(FX.r12.from), await stockOf(FX.r12.to)]).toEqual([a + 2, b - 2]);
    expect((await items(FX.r12.saleId)).map((i) => i.product_id)).toEqual([FX.r12.to]);
    expect(await sale(FX.r12.saleId)).toMatchObject({ total: 47_000_000 });
    evidence.r12 = { sale: FX.r12, plan: flat(r.text), stockLevels: { [FX.r12.from]: [a, a + 2], [FX.r12.to]: [b, b - 2] }, ...ids(r.d) };
  });

  // ── Hard paths ───────────────────────────────────────────────────────────
  it('CONFLICT — sale changed between plan and confirm → Spanish CONFLICT, nothing applied → clean re-plan', async () => {
    const m = await marks();
    const first = await plan(`La venta ${FX.conflict.localId} era de $52.000 y no de $49.000, corregí el precio.`);
    expect(first.pending.steps[0].expectedTotalSnapshot).toBe(4_900_000);

    // Someone else corrects it first (the harness credential, not the agent).
    const res = await fetch(`${process.env.PONTIMPO_API_URL}/api/v1/sales/${FX.conflict.saleId}/corrections`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.PONTIMPO_DEV_FIXTURE_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `dev-live-fixture-${randomUUID()}` },
      body: JSON.stringify({ expected_current_total_centavos: 4_900_000, lines: [{ sale_item_id: FX.conflict.itemId, unit_price_centavos: 5_000_000 }], reason: 'S6 harness: cambio concurrente', on_behalf_of: 's6-harness' }),
    });
    expect(res.status).toBe(200);
    const interference = await delta(m);

    const refused = await confirm();
    expect(refused).toMatch(/No pude aplicar la corrección/);
    expect(refused).toContain('El registro fue modificado por otra persona, recarga e intenta de nuevo');
    expect(ids(await delta(m)), 'the stale plan applied nothing').toEqual(ids(interference));
    expect((await store.getThread(FROM)).pending).toBeNull();

    const m2 = await marks();
    const again = await plan(`Ya lo revisé: la venta ${FX.conflict.localId} tiene que quedar en $52.000. Corregila de nuevo con los datos actuales.`);
    expect(again.pending.steps[0].expectedTotalSnapshot).toBe(5_000_000);
    const done = await confirm();
    expect(done).toMatch(/^Listo\./);
    const d = await delta(m2);
    expect(d.ledger).toEqual([expect.objectContaining({ kind: 'adjustment', amount: 200_000, ...agentRow(), on_behalf_of: STAFF.onBehalfOf })]);
    expect(d.audit).toEqual([byAgent('sale.corrected', STAFF.onBehalfOf)]);
    expect(await sale(FX.conflict.saleId)).toEqual({ status: 'pending', total: 5_200_000 });
    evidence.conflict = { sale: FX.conflict, firstPlan: flat(first.text), interference: ids(interference), refused: flat(refused), replan: flat(again.text), ...ids(d) };
  });

  it('scope — a write the credential lacks (product price) → Spanish refusal, no plan, no mutation, no SQL', async () => {
    const m = await marks();
    const [p] = await q<{ price: number }>('SELECT price_centavos::int AS price FROM product WHERE id = $1', [FX.scope.productId]);
    await processInbound(text(`Cambiá el precio de la cámara moto código ${FX.scope.code} a $8.000 en el catálogo.`));
    const reply = kapso.lastReply();
    expect(reply.buttons).toBe(false);
    expect((await store.getThread(FROM)).pending).toBeNull();
    expect(harness.toolCalls.filter((t) => MUTATIONS.includes(t) || t === 'executeSQL')).toEqual([]);
    expect(reply.text).toMatch(/no puedo|no tengo (permiso|acceso)|fuera de (mi|lo que)|no está a mi alcance/i);
    expect(await delta(m)).toEqual({ ledger: [], cash: [], stock: [], audit: [] });
    expect((await q<{ price: number }>('SELECT price_centavos::int AS price FROM product WHERE id = $1', [FX.scope.productId]))[0].price).toBe(p.price);

    // And the API itself refuses those writes for this credential, in Spanish.
    const post = (path: string, body: unknown) => fetch(`${process.env.PONTIMPO_API_URL}/api/v1${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.PONTIMPO_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `dev-live-scope-${randomUUID()}` },
      body: JSON.stringify(body),
    });
    const createSale = await post('/sales', { client_id: FX.r4.clientId, lines: [{ product_id: FX.scope.productId, quantity: 1 }] });
    const stockAdj = await post(`/products/${FX.scope.productId}/stock-adjustments`, { quantity_delta: 1, reason: 'x' });
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
      await processInbound(text(`Anulá la venta ${FX.r2.localId}, fue un error.`, STRANGER));
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

  it('afterwards: pontimpo `pnpm reconcile` on pontimpo_dev exits 0', () => {
    const run = spawnSync('pnpm', ['reconcile'], {
      cwd: new URL('../../../pontimpo-tire-system', import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: process.env.PONTIMPO_DEV_VERIFY_DATABASE_URL },
      encoding: 'utf8',
    });
    evidence.reconcile = { status: run.status, tail: run.stdout.trim().split('\n').slice(-12) };
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });
});
