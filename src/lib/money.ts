// Mirror of the Pontimpo app's src/lib/money.ts (DOMAIN_SPEC §4.1, SCHEMA §2).
// Money is integer **centavos** at the API boundary; no floats touch money.
// Kept byte-for-byte in sync with the app so the agent parses/formats amounts
// exactly as the server does (round half away from zero, es-AR, USD ÷100).

// Domain bound: $100.000 millones ARS.
export const MAX_MONEY_CENTAVOS = 1_000_000_000_000_0;

/** Throws if `value` is not an exact in-range integer amount of centavos. */
export function assertCentavos(value: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_MONEY_CENTAVOS) {
    throw new TypeError(`Monto inválido en centavos: ${value}`);
  }
}

// Rounds half away from zero ("round half-up" in commercial es-AR usage).
// Compensates binary float error first so decimal-true halves round up.
function roundHalfAwayFromZero(x: number): number {
  const abs = Math.abs(x);
  const compensated = abs * (1 + Number.EPSILON * 4);
  const rounded = Math.floor(compensated + 0.5);
  if (rounded === 0) return 0; // never emit -0
  return x < 0 ? -rounded : rounded;
}

/** Pesos (possibly float-dirty) → integer centavos, half away from zero. */
export function toCentavos(pesos: number): number {
  if (!Number.isFinite(pesos)) {
    throw new TypeError(`Monto inválido en pesos: ${pesos}`);
  }
  const result = roundHalfAwayFromZero(pesos * 100);
  assertCentavos(result);
  return result;
}

/** Exact integer sum; throws on any non-integer input or overflow. */
export function addCentavos(...values: number[]): number {
  let sum = 0;
  for (const value of values) {
    assertCentavos(value);
    sum += value;
  }
  assertCentavos(sum);
  return sum;
}

/**
 * USD denomination → ARS centavos (DOMAIN_SPEC §4.1). Both inputs in centavos:
 * USD cents × (ARS centavos per 1 USD) ÷ 100 (cents per dollar). Worked example:
 * US$100.00 (10.000¢) at $1.485,00/USD (148.500¢/USD) → 10.000 × 148.500 ÷ 100
 * = 14.850.000 ARS centavos = $148.500,00.
 */
export function usdToArs(amountUsdCentavos: number, fxRateCentavos: number): number {
  assertCentavos(amountUsdCentavos);
  assertCentavos(fxRateCentavos);
  const result = roundHalfAwayFromZero((amountUsdCentavos * fxRateCentavos) / 100);
  assertCentavos(result);
  return result;
}

/**
 * es-AR money input → integer centavos. Accepts "1.234,56", "1234,56",
 * "1234.56" (single dot + ≤2 decimals) and plain "1234". Returns null on
 * anything else — callers map that to a validation message.
 */
export function parsePesosInput(raw: string): number | null {
  const input = raw.trim().replace(/\$\s?/, '');
  if (!input) return null;

  let normalized: string;
  if (input.includes(',')) {
    normalized = input.replaceAll('.', '').replace(',', '.');
  } else {
    const dots = input.split('.').length - 1;
    const decimals = input.length - input.indexOf('.') - 1;
    normalized = dots === 1 && decimals <= 2 ? input : input.replaceAll('.', '');
  }
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return toCentavos(Number(normalized));
}

const arsFormatter = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
});

/** Integer centavos → "$ 1.234,56" (es-AR). */
export function formatCentavos(centavos: number): string {
  assertCentavos(centavos);
  const normalized = Object.is(centavos, -0) ? 0 : centavos;
  return arsFormatter.format(normalized / 100);
}

const usdFormatter = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'USD',
});

/** Integer USD cents → "US$ 100,00" (es-AR). */
export function formatUsdCentavos(usdCentavos: number): string {
  assertCentavos(usdCentavos);
  return usdFormatter.format(usdCentavos / 100);
}

const rateFormatter = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Fx rate in ARS centavos per USD → "1.485,00" (no symbol). */
export function formatFxRate(fxRateCentavos: number): string {
  assertCentavos(fxRateCentavos);
  return rateFormatter.format(fxRateCentavos / 100);
}
