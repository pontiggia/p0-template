import { MockLanguageModelV4 } from 'ai/test';

/**
 * A deterministic stand-in for the LLM: each `generateText` step consumes the
 * next turn of the script. A turn is either final text, or tool calls the SDK
 * then executes against the real tools. Turns can be functions of the prompt,
 * so a scripted "model" can plan from what its reads actually returned.
 */
type Prompt = Parameters<MockLanguageModelV4['doGenerate']>[0]['prompt'];
type ToolCall = { tool: string; input: Record<string, unknown> };
export type Turn = string | ToolCall[] | ((prompt: Prompt) => string | ToolCall[]);

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

export function scriptedModel(script: Turn[]) {
  let i = 0;
  let callSeq = 0;
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const raw = script[i++];
      if (raw === undefined) throw new Error(`scripted model ran out of turns (step ${i})`);
      const turn = typeof raw === 'function' ? raw(prompt) : raw;
      if (typeof turn === 'string') {
        return { content: [{ type: 'text', text: turn }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
      }
      return {
        content: turn.map((c) => ({
          type: 'tool-call' as const,
          toolCallId: `call-${++callSeq}`,
          toolName: c.tool,
          input: JSON.stringify(c.input),
        })),
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

/** The output of the most recent tool result for `toolName` in the prompt. */
export function lastToolOutput<T = any>(prompt: Prompt, toolName: string): T { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let m = prompt.length - 1; m >= 0; m--) {
    const msg = prompt[m];
    if (msg.role !== 'tool') continue;
    for (const part of [...msg.content].reverse()) {
      if (part.type === 'tool-result' && part.toolName === toolName && part.output.type === 'json') {
        return part.output.value as T;
      }
    }
  }
  throw new Error(`no ${toolName} result in prompt`);
}

export const r = 'test'; // reasoning arg every tool requires
