/**
 * Phase 9.2 behavioural check (offline): money round-trips + plan-accumulator.
 * Run: pnpm exec tsx scripts/verify-92.mts
 * (Resolver + getSale-against-live-Pontimpo are covered in the 9.6 matrix.)
 */
import {
  formatCentavos,
  parsePesosInput,
  usdToArs,
  formatUsdCentavos,
  formatFxRate,
} from '../src/lib/money.ts';
import { createPontimpoTools } from '../src/lib/pontimpo/tools.ts';
import type { PlannedStep } from '../src/lib/session/types.ts';

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}

// ── money ──
check('parse "$148.500,00" → 14850000¢', parsePesosInput('$148.500,00') === 14850000, parsePesosInput('$148.500,00'));
check('parse "1.234,56" → 123456¢', parsePesosInput('1.234,56') === 123456, parsePesosInput('1.234,56'));
check('parse "1234.56" → 123456¢', parsePesosInput('1234.56') === 123456, parsePesosInput('1234.56'));
check('parse "1234" → 123400¢', parsePesosInput('1234') === 123400, parsePesosInput('1234'));
check('parse "1.234" → 123400¢ (thousands)', parsePesosInput('1.234') === 123400, parsePesosInput('1.234'));
check('parse garbage → null', parsePesosInput('abc') === null);
check('format 14850000¢ contains 148.500,00', formatCentavos(14850000).includes('148.500,00'), formatCentavos(14850000));
// USD worked example: US$100 (10000¢) @ 1.485,00 (148500¢/USD) → 14.850.000 ARS¢
check('usdToArs(10000, 148500) === 14850000', usdToArs(10000, 148500) === 14850000, usdToArs(10000, 148500));
check('formatUsdCentavos(10000) → US$ 100,00', formatUsdCentavos(10000).includes('100,00'), formatUsdCentavos(10000));
check('formatFxRate(148500) → 1.485,00', formatFxRate(148500) === '1.485,00', formatFxRate(148500));

// ── plan-accumulator: mutation tools stage steps, do NOT POST ──
// Guard against any accidental network: stub fetch to throw.
const realFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error('NETWORK CALLED during staging — plan-accumulator must not POST');
}) as typeof fetch;

const steps: PlannedStep[] = [];
const tools = createPontimpoTools({ onBehalfOf: 'oscar@x.com', staffName: 'Oscar', corrId: 'abc123', steps });

// reversePayment: stages one step with on_behalf_of + a minted key, no POST
const r1 = await tools.reversePayment.execute!(
  { ledgerEntryId: 555, reason: 'pago mal cargado', reasoning: 'revertir' } as never,
  {} as never,
);
check('reversePayment staged (no throw/POST)', (r1 as { success: boolean }).success === true);
check('one step accumulated', steps.length === 1, steps.length);
check('step has minted idempotency key', typeof steps[0]?.idempotencyKey === 'string' && steps[0].idempotencyKey.length > 10);
check('step path correct', steps[0]?.path === '/ledger-entries/555/reverse', steps[0]?.path);
check('step body carries on_behalf_of', steps[0]?.body.on_behalf_of === 'oscar@x.com');
check('step reason tagged with corr id', String(steps[0]?.body.reason).includes('corr:abc123'));

// registerSalePayment USD: ARS-approx in summary, USD triple in body
const r2 = await tools.registerSalePayment.execute!(
  { saleId: 4123, paymentMethod: 'efectivo', currency: 'USD', amountUsdCentavos: 10000, fxRateCentavos: 148500, reasoning: 'pago usd' } as never,
  {} as never,
);
check('registerSalePayment USD staged', (r2 as { success: boolean }).success === true);
check('two steps now', steps.length === 2, steps.length);
check('USD body has amount_usd_centavos', steps[1]?.body.amount_usd_centavos === 10000);
check('USD body has currency USD', steps[1]?.body.currency === 'USD');
check('payment description tags staff + corr', String(steps[1]?.body.description).includes('Oscar') && String(steps[1]?.body.description).includes('corr:abc123'));
check('all keys unique', new Set(steps.map((s) => s.idempotencyKey)).size === steps.length);

globalThis.fetch = realFetch;
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
