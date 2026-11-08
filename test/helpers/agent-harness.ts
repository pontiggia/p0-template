import type { LanguageModel } from 'ai';

import type { InboundMessage } from '@/lib/whatsapp/inbound';

/**
 * Tool-layer instrumentation for the agent-loop suites. Each suite does:
 *
 *   vi.mock('@ai-sdk/anthropic', () => anthropicMock());
 *   vi.mock('@/lib/pontimpo/tools', (io) => pontimpoToolsMock(io));
 *   vi.mock('@/lib/tools', (io) => analyticsToolsMock(io));
 *
 * so every tool the model can reach records its name in `toolCalls` before
 * running for real, and the "Anthropic" model is whatever `harness.model` is.
 */
export const harness = {
  model: null as LanguageModel | null,
  modelCalls: 0,
  toolCalls: [] as string[],
  reset() {
    this.model = null;
    this.modelCalls = 0;
    this.toolCalls.length = 0;
  },
};

type AnyTools = Record<string, { execute?: (...args: never[]) => unknown }>;
function spy<T extends AnyTools>(tools: T): T {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => [
      name,
      {
        ...t,
        execute: async (...args: never[]) => {
          harness.toolCalls.push(name);
          return t.execute!(...args);
        },
      },
    ]),
  ) as T;
}

export function anthropicMock() {
  return {
    anthropic: () => {
      harness.modelCalls++;
      if (!harness.model) throw new Error('test reached the model without scripting one');
      return harness.model;
    },
  };
}

export async function pontimpoToolsMock(importOriginal: <T>() => Promise<T>) {
  const real = await importOriginal<typeof import('@/lib/pontimpo/tools')>();
  return {
    ...real,
    createPontimpoTools: (ctx: Parameters<typeof real.createPontimpoTools>[0]) => spy(real.createPontimpoTools(ctx)),
  };
}

export async function analyticsToolsMock(importOriginal: <T>() => Promise<T>) {
  const real = await importOriginal<typeof import('@/lib/tools')>();
  const { executeCommand, executeSQL } = spy({ executeCommand: real.executeCommand, executeSQL: real.executeSQL });
  return { ...real, executeCommand, executeSQL };
}

export const STAFF = { from: '5490000000001', staffName: 'Oscar Prueba', onBehalfOf: 'oscar.prueba@test.local' };
export const STRANGER = '5490000000999';

let msgSeq = 0;
export const text = (body: string, from = STAFF.from): InboundMessage => ({
  kind: 'text', from, messageId: `wamid.t${++msgSeq}`, phoneNumberId: null, isNewConversation: false, text: body,
});
export const tap = (buttonId: 'confirm' | 'cancel', from = STAFF.from): InboundMessage => ({
  kind: 'button', from, messageId: `wamid.b${++msgSeq}`, phoneNumberId: null, isNewConversation: false,
  buttonId, buttonTitle: buttonId === 'confirm' ? 'Confirmar' : 'Cancelar',
});
