// §13 "Scope & allowlist: a metrics-only path can't mutate; an unknown number
// is refused" — the allowlist half and the static scope guarantees. Zero tool
// calls is asserted at the tool layer (every tool's execute is instrumented).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { analyticsToolsMock, anthropicMock, harness, pontimpoToolsMock, STAFF, STRANGER, tap, text } from './helpers/agent-harness';
import { startKapsoStub, type KapsoStub } from './helpers/kapso-stub';
import { r, scriptedModel } from './helpers/scripted-model';

vi.mock('@ai-sdk/anthropic', () => anthropicMock());
vi.mock('@/lib/pontimpo/tools', (io) => pontimpoToolsMock(io));
vi.mock('@/lib/tools', (io) => analyticsToolsMock(io));

const { processInbound } = await import('@/lib/agent/process');
const { createPontimpoTools } = await import('@/lib/pontimpo/tools');
const { getSessionStore } = await import('@/lib/session/store');

let kapso: KapsoStub;
const fetchSpy = vi.spyOn(globalThis, 'fetch');
beforeAll(async () => {
  kapso = await startKapsoStub();
});
afterAll(() => kapso.close());
beforeEach(() => {
  harness.reset();
  kapso.reset();
  fetchSpy.mockClear();
});

const nonKapsoFetches = () =>
  fetchSpy.mock.calls.filter(([u]) => !String(u instanceof Request ? u.url : u).startsWith(process.env.KAPSO_BASE_URL!));

describe('allowlist', () => {
  // A model that would immediately stage a correction if it were ever asked.
  const eager = () => scriptedModel([[{ tool: 'cancelSale', input: { saleId: 1, reason: 'x', reasoning: r } }], 'plan']);

  it.each([
    ['a correction request', text('anulá la venta 1, fue un error', STRANGER)],
    ['an analytics question', text('¿cuánto vendimos hoy?', STRANGER)],
    ['a Confirmar tap', tap('confirm', STRANGER)],
  ])('unknown number + %s → one Spanish refusal, zero model and tool calls', async (_, msg) => {
    harness.model = eager();
    await processInbound(msg);

    expect(harness.modelCalls).toBe(0);
    expect(harness.toolCalls).toEqual([]);
    expect(nonKapsoFetches()).toEqual([]); // no Pontimpo, no Anthropic, nothing
    expect(kapso.sent).toHaveLength(1); // not even a read receipt
    expect(kapso.lastReply().text).toMatch(/no puedo atender este número/);
    expect(kapso.lastReply().raw.body.to).toBe(STRANGER);
    expect((await getSessionStore().getThread(STRANGER)).history).toEqual([]);
  });

  it('control: the allowlisted number does reach the model (the refusal test is not vacuous)', async () => {
    harness.model = scriptedModel(['Hola Oscar, ¿en qué te ayudo?']);
    await processInbound(text('hola'));
    expect(harness.modelCalls).toBe(1);
    expect(kapso.lastReply().text).toBe('Hola Oscar, ¿en qué te ayudo?');
  });
});

describe('scope: what the Phase-1 agent can reach', () => {
  const tools = createPontimpoTools({ onBehalfOf: STAFF.onBehalfOf, staffName: STAFF.staffName, corrId: 'c', steps: [] });

  it('exposes reads + exactly the seven mutating recipes — no create-sale, stock, price or debt tool', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'cancelSale', 'correctSaleAmount', 'findClients', 'findProducts', 'findSales', 'getAuditEvents', 'getClient',
      'getClientLedger', 'getSale', 'refundSale', 'registerClientPayment', 'registerSalePayment',
      'resolveLedgerEntryByNumber', 'resolveSaleByNumber', 'reversePayment', 'swapSaleLine',
    ]);
  });

  it('every mutation tool only stages (no POST) and only targets its recipe endpoint, with on_behalf_of on corrections', async () => {
    const steps: import('@/lib/session/types').PlannedStep[] = [];
    const t = createPontimpoTools({ onBehalfOf: STAFF.onBehalfOf, staffName: STAFF.staffName, corrId: 'c', steps });
    const opts = { toolCallId: 'x', messages: [] } as never;
    await t.cancelSale.execute!({ saleId: 1, reason: 'x', reasoning: r }, opts);
    await t.refundSale.execute!({ saleId: 1, method: 'efectivo', reason: 'x', reasoning: r }, opts);
    await t.correctSaleAmount.execute!({ saleId: 1, expectedCurrentTotalCentavos: 1, lines: [{ saleItemId: 1, unitPriceCentavos: 1 }], reason: 'x', reasoning: r }, opts);
    await t.reversePayment.execute!({ ledgerEntryId: 1, reason: 'x', reasoning: r }, opts);
    await t.swapSaleLine.execute!({ saleId: 1, saleItemId: 1, newProductId: 2, expectedCurrentTotalCentavos: 1, reason: 'x', reasoning: r }, opts);
    await t.registerSalePayment.execute!({ saleId: 1, paymentMethod: 'efectivo', full: true, reasoning: r }, opts);
    await t.registerClientPayment.execute!({ clientId: 1, paymentMethod: 'efectivo', amountCentavos: 100, reasoning: r }, opts);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(steps.map((s) => s.path)).toEqual([
      '/sales/1/cancel', '/sales/1/refund', '/sales/1/corrections', '/ledger-entries/1/reverse',
      '/sales/1/line-swaps', '/sales/1/payments', '/clients/1/payments',
    ]);
    for (const s of steps.slice(0, 5)) expect(s.body.on_behalf_of).toBe(STAFF.onBehalfOf);
    // R2/R4 take no on_behalf_of (owner decision 2026-06-14): the staff name rides in the description.
    for (const s of steps.slice(5)) expect(s.body.description).toContain('En nombre de Oscar Prueba');
    expect(new Set(steps.map((s) => s.idempotencyKey)).size).toBe(7);
  });
});
