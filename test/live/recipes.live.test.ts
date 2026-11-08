// §13 "run each recipe end-to-end (R2, R4, R5, R6, R7, R11, R12)" through the
// REAL agent loop (Anthropic) — a Spanish WhatsApp message in, a plan with
// Confirmar/Cancelar out, Confirmar, then the database checked for exactly what
// DOMAIN_SPEC says: ledger, cash, stock, and audit_event with
// actor_type='agent', the agent credential, and on_behalf_of = the staff member.
//
//   pnpm pontimpo:up
//   ANTHROPIC_API_KEY=… pnpm test:live
//   pnpm pontimpo:down
//
// Skipped without ANTHROPIC_API_KEY. Kapso stays the local stub; the network
// guard (test/setup.ts) only adds api.anthropic.com for this suite. A
// "reconcile → 0" check runs last.
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { STAFF, tap, text } from '../helpers/agent-harness';
import { startKapsoStub, type KapsoStub } from '../helpers/kapso-stub';
import {
  agentCredentialId, auditFor, cashForLedger, closeTestDb, getSaleAsFixture, ledgerForClient, ledgerForSale,
  makeFixtures, PONTIMPO_DIR, requirePontimpoApp, seededProducts, stockOf, type FixtureRow,
} from '../helpers/pontimpo';

const LIVE = Boolean(process.env.ANTHROPIC_API_KEY);
// PONTIMPO_TARGET=dev runs test/live/dev-data.live.test.ts instead.
const HERMETIC = process.env.PONTIMPO_TARGET !== 'dev';

describe.skipIf(!LIVE || !HERMETIC)('seven mutating recipes through the live agent', () => {
  let processInbound: typeof import('@/lib/agent/process').processInbound;
  let getSessionStore: typeof import('@/lib/session/store').getSessionStore;
  let kapso: KapsoStub;
  let agentId: number;
  let products: Awaited<ReturnType<typeof seededProducts>>;
  let fx: Record<'r2' | 'r4' | 'r5' | 'r6' | 'r7' | 'r11' | 'r12', FixtureRow>;

  beforeAll(async () => {
    requirePontimpoApp();
    ({ processInbound } = await import('@/lib/agent/process'));
    ({ getSessionStore } = await import('@/lib/session/store'));
    kapso = await startKapsoStub();
    agentId = await agentCredentialId();
    products = await seededProducts();
    const [r2, r4, r5, r6, r7, r11, r12] = makeFixtures([
      { product: '1001' },                // R2 pending sale
      {},                                 // R4 client only
      { product: '2001', quantity: 2 },   // R5 pending sale
      { product: '2001', paid: true },    // R6 paid sale
      { product: '1001' },                // R7 pending sale
      { product: '1001', paid: true },    // R11 paid in full, efectivo
      { product: '1001' },                // R12 pending sale
    ]);
    fx = { r2, r4, r5, r6, r7, r11, r12 };
  });
  afterAll(async () => {
    await kapso?.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    kapso.reset();
    await getSessionStore().setThread(STAFF.from, { history: [], pending: null });
  });

  /** Message → plan with buttons → Confirmar → "Listo". */
  async function correct(message: string) {
    await processInbound(text(message));
    const plan = kapso.lastReply();
    expect(plan.buttons, `expected a plan to confirm, got: ${plan.text}`).toBe(true);
    await processInbound(tap('confirm'));
    const done = kapso.lastReply();
    expect(done.text, done.text).toMatch(/^Listo\./);
    return { plan: plan.text, done: done.text };
  }

  const agentAudit = (action: string, onBehalfOf: string | null = STAFF.onBehalfOf) =>
    expect.objectContaining({ action, actor_type: 'agent', credential_id: agentId, on_behalf_of: onBehalfOf });

  it('R2 — register the full payment on a sale', async () => {
    const id = fx.r2.saleId!;
    await correct(`Registrá el pago total de la venta ${fx.r2.saleLocalId} en efectivo.`);
    const [p] = (await ledgerForSale(id)).filter((e) => e.kind === 'payment');
    expect(p).toMatchObject({ amount: -9_500_000, payment_method: 'efectivo', credential_id: agentId, on_behalf_of: STAFF.onBehalfOf });
    expect(p.description).toContain(STAFF.staffName);
    expect(await cashForLedger([p.id])).toMatchObject([{ kind: 'payment_received', method: 'efectivo', amount: 9_500_000 }]);
    expect((await getSaleAsFixture(id)).status).toBe('paid');
    expect(await auditFor('sale', id)).toContainEqual(agentAudit('sale.payment_registered'));
  });

  it('R4 — register a client-level payment', async () => {
    const c = fx.r4;
    await correct(`El cliente ${c.clientName} (cliente número ${c.clientLocalId}) dejó $5.000 en efectivo a cuenta. Registralo como pago a cuenta del cliente, sin venta.`);
    const [p] = (await ledgerForClient(c.clientId)).filter((e) => e.kind === 'payment');
    expect(p).toMatchObject({ amount: -500_000, sale_id: null, payment_method: 'efectivo', credential_id: agentId, on_behalf_of: STAFF.onBehalfOf });
    expect(await cashForLedger([p.id])).toMatchObject([{ method: 'efectivo', amount: 500_000 }]);
    expect(await auditFor('client', c.clientId)).toContainEqual(agentAudit('client.payment_registered'));
  });

  it('R5 — cancel an unpaid sale (stock comes back)', async () => {
    const id = fx.r5.saleId!;
    const stockBefore = await stockOf(products.tube.id);
    await correct(`Anulá la venta ${fx.r5.saleLocalId}, la cargué por error.`);
    expect((await getSaleAsFixture(id)).status).toBe('cancelled');
    expect(await stockOf(products.tube.id)).toBe(stockBefore + 2);
    expect((await ledgerForSale(id)).map((e) => e.kind)).toEqual(['sale', 'cancellation']);
    expect(await auditFor('sale', id)).toContainEqual(agentAudit('sale.cancelled'));
  });

  it('R6 — refund a paid sale in cash, restocking it', async () => {
    const id = fx.r6.saleId!;
    const stockBefore = await stockOf(products.tube.id);
    await correct(`Reembolsá la venta ${fx.r6.saleLocalId} en efectivo: el cliente devolvió la cámara y vuelve al stock.`);
    expect((await getSaleAsFixture(id)).status).toBe('refunded');
    expect(await stockOf(products.tube.id)).toBe(stockBefore + 1);
    const refund = (await ledgerForSale(id)).find((e) => e.kind === 'refund')!;
    expect(refund).toMatchObject({ amount: 1_500_000, payment_method: 'efectivo', credential_id: agentId, on_behalf_of: STAFF.onBehalfOf });
    expect(await cashForLedger([refund.id])).toMatchObject([{ kind: 'refund', method: 'efectivo', amount: -1_500_000 }]);
    expect(await auditFor('sale', id)).toContainEqual(agentAudit('sale.refunded'));
  });

  it('R7 — correct a sale amount (price only)', async () => {
    const id = fx.r7.saleId!;
    await correct(`La venta ${fx.r7.saleLocalId} era de $100.000 y no de $95.000, corregí el precio.`);
    const sale = await getSaleAsFixture(id);
    expect(sale.total_centavos).toBe(10_000_000);
    expect(sale.items[0].unit_price_centavos).toBe(10_000_000);
    expect(await auditFor('sale', id)).toContainEqual(agentAudit('sale.corrected'));
  });

  it('R11 + R2 ×4 — "la cobré en efectivo pero fueron 4 cheques"', async () => {
    const id = fx.r11.saleId!;
    const [original] = (await ledgerForSale(id)).filter((e) => e.kind === 'payment');
    await correct(`La venta ${fx.r11.saleLocalId} la cobré toda en efectivo pero en realidad fueron 4 cheques de $23.750 cada uno.`);

    const ledger = await ledgerForSale(id);
    const reversal = ledger.find((e) => e.reverses_entry_id != null)!;
    expect(reversal).toMatchObject({ kind: 'adjustment', amount: 9_500_000, credential_id: agentId, on_behalf_of: STAFF.onBehalfOf });
    expect(Number(reversal.reverses_entry_id)).toBe(Number(original.id));
    const cheques = ledger.filter((e) => e.kind === 'payment' && e.payment_method === 'cheque');
    expect(cheques.map((e) => e.amount)).toEqual([-2_375_000, -2_375_000, -2_375_000, -2_375_000]);
    expect(cheques.every((e) => e.credential_id === agentId)).toBe(true);
    const sale = await getSaleAsFixture(id);
    expect(sale.status).toBe('paid');
    expect(await auditFor('sale', id)).toContainEqual(agentAudit('sale.payment_reversed'));
  });

  it('R12 — swap the wrong product on a line (stock corrected on both)', async () => {
    const id = fx.r12.saleId!;
    const [a, b] = [await stockOf(products.tire.id), await stockOf(products.tire2.id)];
    await correct(
      `En la venta ${fx.r12.saleLocalId} cargué el ${products.tire.name} (código 1001) pero era el ` +
      `${products.tire2.name} (código 1002, id de producto ${products.tire2.id}). Cambiá el producto y dejá el mismo precio.`,
    );
    const sale = await getSaleAsFixture(id);
    expect(sale.items[0].product_id).toBe(products.tire2.id);
    expect(sale.total_centavos).toBe(9_500_000);
    expect([await stockOf(products.tire.id), await stockOf(products.tire2.id)]).toEqual([a + 1, b - 1]);
    expect(await auditFor('sale', id)).toContainEqual(agentAudit('sale.line_swapped'));
  });

  it('afterwards: pontimpo `pnpm reconcile` on the test DB exits 0', () => {
    const run = spawnSync('pnpm', ['reconcile'], {
      cwd: PONTIMPO_DIR,
      env: { ...process.env, DATABASE_URL: process.env.PONTIMPO_TEST_DATABASE_URL },
      encoding: 'utf8',
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });
});
