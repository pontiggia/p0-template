// The agent's Pontimpo client against the REAL local app (pnpm pontimpo:up).
//   §13 Idempotency — same key + same body → the stored response (replayed,
//       no second side effect); same key + different body → IDEMPOTENCY_CONFLICT.
//   §13 Money/USD   — a US$100 @ 1.485,00 payment lands as $148.500,00 in the ledger.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { executePendingAction } from '@/lib/agent/execute';
import { apiPost, getSale, PontimpoApiError } from '@/lib/pontimpo/client';
import { createPontimpoTools } from '@/lib/pontimpo/tools';
import type { PlannedStep } from '@/lib/session/types';

import { STAFF } from './helpers/agent-harness';
import {
  agentCredentialId, cashForLedger, closeTestDb, ledgerForClient, ledgerForSale, makeFixtures,
  requirePontimpoApp, type FixtureRow,
} from './helpers/pontimpo';
import { r } from './helpers/scripted-model';

requirePontimpoApp();

let client: FixtureRow;
let usdSale: FixtureRow;
let agentId: number;
beforeAll(async () => {
  // A client-only fixture (R4) and 2 × "Neumático 185/60 R15" ($248.000) for USD.
  [client, usdSale] = makeFixtures([{}, { product: '1002', quantity: 2 }]);
  agentId = await agentCredentialId();
});
afterAll(closeTestDb);

const payment = (amount: number) => ({ payment_method: 'efectivo', amount_centavos: amount, description: 'S6 idempotencia' });

describe('Idempotency-Key (DOMAIN_SPEC §8) through apiPost', () => {
  it('same key + same body → the stored response, applied once', async () => {
    const key = `s6-${randomUUID()}`;
    const path = `/clients/${client.clientId}/payments`;

    const first = await apiPost<Record<string, unknown>>(path, payment(50_000), key);
    const second = await apiPost<Record<string, unknown>>(path, payment(50_000), key);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.data).toEqual(first.data);

    const rows = (await ledgerForClient(client.clientId)).filter((e) => e.kind === 'payment');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: -50_000, sale_id: null, credential_id: agentId });
    expect(await cashForLedger(rows.map((e) => e.id))).toHaveLength(1);
  });

  it('same key + different body → IDEMPOTENCY_CONFLICT (409, Spanish), nothing applied', async () => {
    const key = `s6-${randomUUID()}`;
    const path = `/clients/${client.clientId}/payments`;
    const before = (await ledgerForClient(client.clientId)).length;

    await apiPost(path, payment(10_000), key);
    const err = await apiPost(path, payment(20_000), key).catch((e) => e);

    expect(PontimpoApiError.is(err)).toBe(true);
    expect(err).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409, userMessage: 'Solicitud repetida con datos diferentes' });
    expect(await ledgerForClient(client.clientId)).toHaveLength(before + 1);
  });

  it('a missing key is rejected by the API (every POST must carry one)', async () => {
    const err = await apiPost(`/clients/${client.clientId}/payments`, payment(1_000), '').catch((e) => e);
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
  });
});

describe('USD payment (DOMAIN_SPEC §4.1) planned by the tool, executed by the client', () => {
  it('US$100 @ 1.485,00 → a $148.500,00 ledger payment carrying all three fields', async () => {
    const steps: PlannedStep[] = [];
    const tools = createPontimpoTools({ onBehalfOf: STAFF.onBehalfOf, staffName: STAFF.staffName, corrId: 'usd00001', steps });
    await tools.registerSalePayment.execute!(
      { saleId: usdSale.saleId!, paymentMethod: 'efectivo', amountUsdCentavos: 10_000, fxRateCentavos: 148_500, reasoning: r },
      { toolCallId: 'u1', messages: [] } as never,
    );
    const outcome = await executePendingAction({ corrId: 'usd00001', steps, createdAt: Date.now() });
    expect(outcome.ok).toBe(true);

    const [row] = (await ledgerForSale(usdSale.saleId!)).filter((e) => e.kind === 'payment');
    expect(row).toMatchObject({ amount: -14_850_000, currency: 'USD', usd: 10_000, fx: 148_500, credential_id: agentId });
    const sale = await getSale(usdSale.saleId!);
    expect(sale.debt_centavos).toBe(24_800_000 - 14_850_000);
  });
});
