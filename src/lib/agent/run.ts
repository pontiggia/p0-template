import { generateText, isStepCount, type ModelMessage } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { randomUUID } from 'node:crypto';
import { executeCommand, executeSQL } from '../tools';
import { createPontimpoTools } from '../pontimpo/tools';
import { buildWaSystemPrompt } from './system-prompt-wa';
import type { PlannedStep } from '../session/types';

// Opus for planning/correction reasoning. (generateText, not streamText — a
// WhatsApp turn is awaited in full, then sent via the Kapso API.)
const MODEL_ID = 'claude-opus-4-8' as const;
const MAX_STEPS = 16;

export interface RunInput {
  readonly staffName: string;
  readonly onBehalfOf: string;
  readonly storeId: number;
  /** prior model messages for this thread (already trimmed) */
  readonly history: ModelMessage[];
  /** the new inbound user turn */
  readonly userText: string;
}

export interface RunResult {
  /** the model's final es-AR message to send */
  readonly text: string;
  /** staged plan (empty for analytics; non-empty for a correction proposal) */
  readonly steps: PlannedStep[];
  /** correlation id for this run's plan (tagged into every step) */
  readonly corrId: string;
  /** updated message history to persist (history + new turns) */
  readonly messages: ModelMessage[];
}

/**
 * Run one WhatsApp agent turn. Analytics answers come back as `text` with no
 * `steps`; corrections come back with a staged `steps` plan that the caller
 * turns into a pending confirmation (nothing is mutated here).
 */
export async function runAgentTurn(input: RunInput): Promise<RunResult> {
  const corrId = randomUUID().slice(0, 8);
  const steps: PlannedStep[] = [];

  const pontimpoTools = createPontimpoTools({
    onBehalfOf: input.onBehalfOf,
    staffName: input.staffName,
    corrId,
    steps,
  });

  const tools = {
    // analytics grounding (charts intentionally excluded for WhatsApp)
    executeCommand,
    executeSQL,
    ...pontimpoTools,
  };

  const userMessage: ModelMessage = { role: 'user', content: input.userText };
  const messages: ModelMessage[] = [...input.history, userMessage];

  const generate = (extra = '') =>
    generateText({
      model: anthropic(MODEL_ID),
      instructions: buildWaSystemPrompt({ staffName: input.staffName, storeId: input.storeId }) + extra,
      messages,
      tools,
      stopWhen: isStepCount(MAX_STEPS),
    });

  // Hard guard (OWNER_QUESTIONS #16): a peso figure must come from data read
  // this turn. One retry with the rule restated, then a safe refusal.
  let result = await generate();
  let text = result.text;
  if (unverifiedAmount(text, input.userText, toolNamesOf(result))) {
    result = await generate(GUARD_RETRY);
    text = unverifiedAmount(result.text, input.userText, toolNamesOf(result)) ? GUARD_FALLBACK : result.text;
  }

  return {
    text,
    steps,
    corrId,
    // v7: response.messages is the final step only; responseMessages is all steps.
    messages:
      text === GUARD_FALLBACK
        ? [...messages, { role: 'assistant', content: GUARD_FALLBACK }]
        : [...messages, ...result.responseMessages],
  };
}

export const GUARD_RETRY =
  '\n\nIMPORTANTE: tu respuesta anterior dio un monto sin consultar datos. Ejecuta executeSQL (o la herramienta de Pontimpo que corresponda) ANTES de responder, y usa solo cifras de ese resultado.';
export const GUARD_FALLBACK =
  'No pude confirmar esa cifra con los datos del sistema. ¿Me lo preguntas de nuevo?';

const toolNamesOf = (r: { steps: ReadonlyArray<{ toolCalls: ReadonlyArray<{ toolName: string }> }> }) =>
  r.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));

// ponytail: "$"-prefixed amounts only — a bare count ("12 ventas") isn't
// guarded; widen the pattern if the live suite ever catches one.
const AMOUNT = /(?:US)?\$\s?\d[\d.,]*/g;
const amountKey = (s: string) => s.replace(/[.,]$/, '').replace(/,\d{1,2}$/, '').replace(/\D/g, '');

/**
 * True when `reply` states a peso amount that neither came from a data tool
 * this turn (executeSQL or any Pontimpo API tool — reading the catalog with
 * executeCommand is not data) nor was typed by the staff member themselves.
 */
export function unverifiedAmount(reply: string, userText: string, toolNames: readonly string[]): boolean {
  if (toolNames.some((n) => n !== 'executeCommand')) return false;
  const typed = new Set((userText.match(/\d[\d.,]*/g) ?? []).map(amountKey));
  return (reply.match(AMOUNT) ?? []).some((a) => !typed.has(amountKey(a)));
}
