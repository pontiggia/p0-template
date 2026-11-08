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

  const result = await generateText({
    model: anthropic(MODEL_ID),
    instructions: buildWaSystemPrompt({ staffName: input.staffName, storeId: input.storeId }),
    messages,
    tools,
    stopWhen: isStepCount(MAX_STEPS),
  });

  return {
    text: result.text,
    steps,
    corrId,
    // v7: response.messages is the final step only; responseMessages is all steps.
    messages: [...messages, ...result.responseMessages],
  };
}
