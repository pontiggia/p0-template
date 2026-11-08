// OWNER_QUESTIONS #16: a peso figure in a reply must come from data read this
// turn (executeSQL or a Pontimpo API tool); otherwise one retry, then a safe
// refusal. Scripted model, no DB.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { anthropicMock, harness } from './helpers/agent-harness';
import { scriptedModel } from './helpers/scripted-model';

vi.mock('@ai-sdk/anthropic', () => anthropicMock());
const { runAgentTurn, unverifiedAmount, GUARD_FALLBACK } = await import('@/lib/agent/run');

const turn = (userText: string) =>
  runAgentTurn({ staffName: 'Oscar', onBehalfOf: 'oscar@test.local', storeId: 1, history: [], userText });

describe('unverifiedAmount', () => {
  it.each([
    ['Vendimos $1.234.567,00 en octubre.', '¿Cuánto vendimos?', [], true],
    ['Vendimos $1.234.567,00 en octubre.', '¿Cuánto vendimos?', ['executeCommand'], true],
    ['Vendimos $1.234.567,00 en octubre.', '¿Cuánto vendimos?', ['executeCommand', 'executeSQL'], false],
    ['La venta #12 debe $40.000,00.', 'cobrale la 12', ['getSale'], false],
    ['¿Registro un pago de $10.000,00?', 'pago de 10000', [], false],
    ['US$100 a $1.485,00 son $148.500,00.', 'US$100 a 1.485', [], true],
    ['¡Hola! ¿En qué te ayudo?', 'hola', [], false],
  ])('%j (user %j, tools %j) → %s', (reply, user, tools, expected) => {
    expect(unverifiedAmount(reply, user, tools)).toBe(expected);
  });
});

describe('runAgentTurn', () => {
  beforeEach(() => harness.reset());

  it('an amount with no query, twice → the safe refusal, never the made-up figure', async () => {
    harness.model = scriptedModel(['Vendimos $1.234.567,00.', 'Fueron $1.234.567,00.']);
    const out = await turn('¿Cuánto vendimos en octubre?');
    expect(harness.modelCalls).toBe(2);
    expect(out.text).toBe(GUARD_FALLBACK);
    expect(JSON.stringify(out.messages)).not.toContain('1.234.567');
  });

  it('an amount with no query, then a clean retry → the retry is sent', async () => {
    harness.model = scriptedModel(['Vendimos $1.234.567,00.', 'No tengo ese dato todavía, ¿de qué mes?']);
    const out = await turn('¿Cuánto vendimos?');
    expect(harness.modelCalls).toBe(2);
    expect(out.text).toBe('No tengo ese dato todavía, ¿de qué mes?');
  });

  it('no amount → one model call, reply untouched', async () => {
    harness.model = scriptedModel(['¡Hola! ¿En qué te ayudo?']);
    const out = await turn('hola');
    expect(harness.modelCalls).toBe(1);
    expect(out.text).toBe('¡Hola! ¿En qué te ayudo?');
  });
});
