// §13 "Money formatting: round-trip es-AR ↔ centavos, including a USD payment
// (US$100 @ 1.485,00 → $148.500,00)". The agent's money.ts must agree with the
// Pontimpo app's (it claims to mirror it), so both are exercised side by side.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import * as agent from '@/lib/money';
import { createPontimpoTools } from '@/lib/pontimpo/tools';
import type { PlannedStep } from '@/lib/session/types';

const APP_MONEY = new URL('../../pontimpo-tire-system/src/lib/money.ts', import.meta.url).pathname;
const nbsp = (s: string) => s.replace(/ /g, ' ');

describe('es-AR ↔ centavos', () => {
  it.each([
    ['$148.500,00', 14_850_000],
    ['148.500,00', 14_850_000],
    ['1.234,56', 123_456],
    ['1234,5', 123_450],
    ['1234.56', 123_456],
    ['100', 10_000],
    ['$ 0,01', 1],
  ])('parses %s → %i centavos', (input, centavos) => {
    expect(agent.parsePesosInput(input)).toBe(centavos);
  });

  it.each(['', 'abc', '1,2,3', '12,345'])('rejects %j', (input) => {
    expect(agent.parsePesosInput(input)).toBeNull();
  });

  it.each([0, 1, 99, 100, 123_456, 14_850_000, 99_999_999_999, -5_000])(
    'format → parse round-trips %i',
    (centavos) => {
      expect(agent.parsePesosInput(agent.formatCentavos(centavos))).toBe(centavos);
    },
  );

  it('formats es-AR with the peso sign and comma decimals', () => {
    expect(nbsp(agent.formatCentavos(14_850_000))).toBe('$ 148.500,00');
  });

  it('never does float money: 0.1 + 0.2 pesos is 30 centavos', () => {
    expect(agent.addCentavos(agent.toCentavos(0.1), agent.toCentavos(0.2))).toBe(30);
    expect(() => agent.assertCentavos(1.5)).toThrow();
  });
});

describe('USD (DOMAIN_SPEC §4.1)', () => {
  it('US$100 @ 1.485,00 → $148.500,00', () => {
    const usd = agent.parsePesosInput('100')!; // 10.000 USD cents
    const rate = agent.parsePesosInput('1.485,00')!; // 148.500 ARS centavos per USD
    const ars = agent.usdToArs(usd, rate);
    expect(ars).toBe(14_850_000);
    expect(nbsp(agent.formatCentavos(ars))).toBe('$ 148.500,00');
    expect(nbsp(agent.formatUsdCentavos(usd))).toBe('US$ 100,00');
    expect(agent.formatFxRate(rate)).toBe('1.485,00');
  });

  it('the plan line the staff confirms shows the same conversion', async () => {
    const steps: PlannedStep[] = [];
    const tools = createPontimpoTools({ onBehalfOf: 'x@test.local', staffName: 'X', corrId: 'c0ffee00', steps });
    await tools.registerSalePayment.execute!(
      { saleId: 7, paymentMethod: 'efectivo', amountUsdCentavos: 10_000, fxRateCentavos: 148_500, reasoning: 't' },
      { toolCallId: 't1', messages: [] } as never,
    );
    expect(nbsp(steps[0].summary)).toContain('US$ 100,00 @ 1.485,00 ≈ $ 148.500,00');
    expect(steps[0].body).toMatchObject({ currency: 'USD', amount_usd_centavos: 10_000, fx_rate_centavos: 148_500 });
  });
});

describe.runIf(existsSync(APP_MONEY))('mirrors the Pontimpo app money.ts', () => {
  it('agrees on parse, format and USD conversion', async () => {
    const app = await import(/* @vite-ignore */ APP_MONEY);
    for (const s of ['$148.500,00', '1.234,56', '1234.56', '100', '0,01', 'abc', '12,345']) {
      expect(agent.parsePesosInput(s), s).toBe(app.parsePesosInput(s));
    }
    for (const c of [0, 1, -5_000, 14_850_000, 99_999_999_999]) {
      expect(agent.formatCentavos(c)).toBe(app.formatCentavos(c));
    }
    for (const [usd, fx] of [[10_000, 148_500], [1, 123_457], [33_333, 99_999]]) {
      expect(agent.usdToArs(usd, fx)).toBe(app.usdToArs(usd, fx));
    }
    for (const p of [1.005, 346.725, 0.125, -2.675]) {
      expect(agent.toCentavos(p), String(p)).toBe(app.toCentavos(p));
    }
  });
});
