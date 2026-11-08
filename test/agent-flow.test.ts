// The confirmation state machine end to end, hermetically: webhook-shaped
// inbound → processInbound → AI SDK loop (scripted model, REAL tools) →
// plan → Confirmar → REAL /api/v1 on the local Pontimpo app → DB verified.
//   §13 Idempotency     — re-running a confirmed action applies nothing twice
//   §13 Optimistic      — sale mutated between plan and confirm → CONFLICT → clean re-plan
//   §13 Scope           — a credential lacking a scope → Spanish refusal, no SQL workaround
//   §13 Reconciliation  — pontimpo's `pnpm reconcile` still exits 0 afterwards
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { analyticsToolsMock, anthropicMock, harness, pontimpoToolsMock, STAFF, tap, text } from './helpers/agent-harness';
import { startKapsoStub, type KapsoStub } from './helpers/kapso-stub';
import {
  agentCredentialId, auditFor, cashForLedger, closeTestDb, fixture, getSaleAsFixture, ledgerForSale,
  makeFixtures, requirePontimpoApp, testDb, type FixtureRow,
} from './helpers/pontimpo';
import { lastToolOutput, r, scriptedModel } from './helpers/scripted-model';

vi.mock('@ai-sdk/anthropic', () => anthropicMock());
vi.mock('@/lib/pontimpo/tools', (io) => pontimpoToolsMock(io));
vi.mock('@/lib/tools', (io) => analyticsToolsMock(io));

requirePontimpoApp();
const { processInbound } = await import('@/lib/agent/process');
const { executePendingAction } = await import('@/lib/agent/execute');
const { getSessionStore } = await import('@/lib/session/store');
const { executeSQL } = await import('@/lib/tools');

const nbsp = (s: string) => s.replace(/ /g, ' ');
const pending = async () => (await getSessionStore().getThread(STAFF.from)).pending;
const payments = async (saleId: number) => (await ledgerForSale(saleId)).filter((e) => e.kind === 'payment');

let kapso: KapsoStub;
let agentId: number;
let fx: Record<'r2' | 'cancel' | 'r7' | 'scope', FixtureRow>;
beforeAll(async () => {
  kapso = await startKapsoStub();
  agentId = await agentCredentialId();
  const [r2, cancel, r7, scope] = makeFixtures([
    { product: '1001' }, { product: '2001' }, { product: '1001' }, { product: '2001' },
  ]);
  fx = { r2, cancel, r7, scope };
});
afterAll(async () => {
  await kapso.close();
  await closeTestDb();
});
beforeEach(async () => {
  harness.reset();
  kapso.reset();
  await getSessionStore().setThread(STAFF.from, { history: [], pending: null });
});

describe('R2 — plan, confirm, then nothing applies twice', () => {
  it('stages without mutating, applies on Confirmar, and a replayed action is a no-op', async () => {
    const sale = await getSaleAsFixture(fx.r2.saleId!);

    harness.model = scriptedModel([
      [{ tool: 'getSale', input: { saleId: sale.id, reasoning: r } }],
      (prompt) => {
        const s = lastToolOutput(prompt, 'getSale').sale;
        return [{ tool: 'registerSalePayment', input: { saleId: s.id, paymentMethod: 'efectivo', amountCentavos: s.deuda_centavos, reasoning: r } }];
      },
      'Te dejo el plan para confirmar.',
    ]);
    await processInbound(text(`cobrame la venta ${sale.local_id} en efectivo`));

    // Plan shown with buttons; nothing mutated yet.
    const plan = kapso.lastReply();
    expect(plan.buttons).toBe(true);
    expect(nbsp(plan.text)).toContain('Registrar pago de $ 95.000,00 (efectivo)');
    expect(plan.text).toContain('¿Confirmás?');
    expect(await payments(sale.id)).toEqual([]);
    expect(harness.toolCalls).toEqual(['getSale', 'registerSalePayment']);
    const staged = (await pending())!;
    expect(staged.steps).toHaveLength(1);

    await processInbound(tap('confirm'));
    expect(kapso.lastReply().text).toMatch(/^Listo\. Hice:/);

    const [payment] = await payments(sale.id);
    expect(payment).toMatchObject({ amount: -9_500_000, payment_method: 'efectivo', credential_id: agentId });
    expect(payment.description).toContain('En nombre de Oscar Prueba — corr:');
    expect(await cashForLedger([payment.id])).toEqual([
      { kind: 'payment_received', method: 'efectivo', amount: 9_500_000, ledger_entry_id: Number(payment.id) },
    ]);
    expect((await getSaleAsFixture(sale.id)).status).toBe('paid');
    expect(await auditFor('sale', sale.id)).toContainEqual(
      expect.objectContaining({ action: 'sale.payment_registered', actor_type: 'agent', credential_id: agentId }),
    );

    // Redelivered Confirmar: the pending plan is gone.
    await processInbound(tap('confirm'));
    expect(kapso.lastReply().text).toBe('No hay nada pendiente para confirmar.');

    // Same action re-executed with its pre-minted keys (a retry racing the
    // clear): the API replays the stored responses, nothing applies twice.
    const replay = await executePendingAction(staged);
    expect(replay.ok).toBe(true);
    expect(replay.message).toContain('(ya estaba hecho)');
    expect(await payments(sale.id)).toHaveLength(1);
  });

  it('Cancelar discards the plan and mutates nothing', async () => {
    const sale = await getSaleAsFixture(fx.cancel.saleId!);
    harness.model = scriptedModel([
      [{ tool: 'registerSalePayment', input: { saleId: sale.id, paymentMethod: 'cheque', full: true, reasoning: r } }],
      'plan',
    ]);
    await processInbound(text('cobrá la venta con cheque'));
    await processInbound(tap('cancel'));
    expect(kapso.lastReply().text).toBe('Listo, cancelado. No toqué nada.');
    expect(await pending()).toBeNull();
    expect(await payments(sale.id)).toEqual([]);
  });
});

describe('R7 — the sale changes between plan and confirm', () => {
  const planCorrection = (saleId: number, newPrice: number) =>
    scriptedModel([
      [{ tool: 'getSale', input: { saleId, reasoning: r } }],
      (prompt) => {
        const s = lastToolOutput(prompt, 'getSale').sale;
        return [{
          tool: 'correctSaleAmount',
          input: {
            saleId, expectedCurrentTotalCentavos: s.total_centavos, reason: 'precio mal cargado', reasoning: r,
            lines: [{ saleItemId: s.items[0].sale_item_id, unitPriceCentavos: newPrice }],
          },
        }];
      },
      'plan',
    ]);

  it('→ CONFLICT with the Spanish message, nothing applied, then a clean re-plan succeeds', async () => {
    const sale = await getSaleAsFixture(fx.r7.saleId!);
    expect(sale.total_centavos).toBe(9_500_000);

    harness.model = planCorrection(sale.id, 10_000_000);
    await processInbound(text(`la venta ${sale.local_id} era 100 mil`));
    expect((await pending())!.steps[0].body.expected_current_total_centavos).toBe(9_500_000);

    // Someone else corrects the same sale in the meantime.
    await fixture.post(`/sales/${sale.id}/corrections`, {
      expected_current_total_centavos: 9_500_000,
      lines: [{ sale_item_id: sale.items[0].id, unit_price_centavos: 9_000_000 }],
      reason: 'otro empleado', on_behalf_of: 'otro@test.local',
    });

    await processInbound(tap('confirm'));
    const report = kapso.lastReply().text;
    expect(report).toContain('No pude aplicar la corrección.');
    expect(report).toContain('El registro fue modificado por otra persona');
    expect(report).toContain('Pedímelo de nuevo');
    expect((await getSaleAsFixture(sale.id)).total_centavos).toBe(9_000_000);
    expect(await pending()).toBeNull();

    // Re-plan from fresh reads: the new snapshot carries the new total.
    harness.model = planCorrection(sale.id, 10_000_000);
    await processInbound(text(`la venta ${sale.local_id} era 100 mil`));
    expect((await pending())!.steps[0].body.expected_current_total_centavos).toBe(9_000_000);
    await processInbound(tap('confirm'));
    expect(kapso.lastReply().text).toMatch(/^Listo\./);
    expect((await getSaleAsFixture(sale.id)).total_centavos).toBe(10_000_000);

    const audit = await auditFor('sale', sale.id);
    expect(audit.filter((a) => a.action === 'sale.corrected')).toEqual([
      expect.objectContaining({ on_behalf_of: 'otro@test.local', actor_type: 'agent' }),
      { action: 'sale.corrected', actor_type: 'agent', credential_id: agentId, on_behalf_of: STAFF.onBehalfOf },
    ]);
  });
});

describe('scope — a credential that lacks payments:write', () => {
  it('confirming → the API refusal in Spanish, no retry, no SQL fallback, no mutation', async () => {
    const sale = await getSaleAsFixture(fx.scope.saleId!);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const agentKey = process.env.PONTIMPO_API_KEY;
    process.env.PONTIMPO_API_KEY = process.env.PONTIMPO_TEST_METRICS_KEY;
    try {
      harness.model = scriptedModel([
        [{ tool: 'registerSalePayment', input: { saleId: sale.id, paymentMethod: 'efectivo', full: true, reasoning: r } }],
        'plan',
      ]);
      await processInbound(text('cobrá la venta en efectivo'));
      await processInbound(tap('confirm'));

      const report = kapso.lastReply().text;
      expect(report).toContain('No pude aplicar la corrección.');
      expect(report).toContain('No tienes permiso para realizar esta acción');
      const posts = fetchSpy.mock.calls.filter(([u, init]) => String(u).startsWith(process.env.PONTIMPO_API_URL!) && init?.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(harness.toolCalls).not.toContain('executeSQL');
      expect(harness.toolCalls).not.toContain('executeCommand');
      expect(await pending()).toBeNull();
      expect(await payments(sale.id)).toEqual([]);
    } finally {
      process.env.PONTIMPO_API_KEY = agentKey;
      fetchSpy.mockRestore();
    }
  });

  it('the SQL gateway refuses writes, so SQL is no workaround', async () => {
    const before = await testDb().query('SELECT count(*)::int AS n FROM client_ledger_entry');
    const opts = { toolCallId: 'x', messages: [] } as never;
    const attempts = [
      "UPDATE sale SET status = 'paid'",
      "INSERT INTO client_ledger_entry (kind) VALUES ('payment')",
      'WITH d AS (DELETE FROM cash_movement RETURNING 1) SELECT * FROM d',
      'SELECT 1; UPDATE sale SET status = $$paid$$',
    ];
    for (const sql of attempts) {
      const res = (await executeSQL.execute!({ sql, explanation: 'x' }, opts)) as { success: boolean };
      expect(res.success, sql).toBe(false);
    }
    const ok = (await executeSQL.execute!({ sql: 'SELECT count(*) AS n FROM sale', explanation: 'x' }, opts)) as { success: boolean };
    expect(ok.success).toBe(true);
    expect((await testDb().query('SELECT count(*)::int AS n FROM client_ledger_entry')).rows).toEqual(before.rows);
  });
});

describe('invariants after the agent corrections', () => {
  it('pontimpo `pnpm reconcile` on the test DB exits 0', () => {
    const run = spawnSync('pnpm', ['reconcile'], {
      cwd: new URL('../../pontimpo-tire-system', import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: process.env.PONTIMPO_TEST_DATABASE_URL },
      encoding: 'utf8',
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });
});
