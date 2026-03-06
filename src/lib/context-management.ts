/* eslint-disable @typescript-eslint/no-explicit-any */

type UIMessage = any;

export interface ContextConfig {
  readonly maxMessages: number;
  readonly maxTokensEstimate: number;
}

export type Summarizer = (text: string) => Promise<string>;

export interface CompressionResult {
  readonly messages: readonly UIMessage[];
  readonly wasCompressed: boolean;
  readonly droppedCount: number;
}

const DEFAULT_CONFIG: ContextConfig = {
  maxMessages: 20,
  maxTokensEstimate: 50_000,
} as const;

export function compressMessages(
  messages: readonly UIMessage[],
  config: ContextConfig = DEFAULT_CONFIG,
): CompressionResult {
  const { maxMessages } = config;

  if (messages.length <= maxMessages) {
    return {
      messages,
      wasCompressed: false,
      droppedCount: 0,
    };
  }

  const firstMessage = messages[0];
  if (firstMessage === undefined) {
    return {
      messages: [],
      wasCompressed: false,
      droppedCount: 0,
    };
  }

  const recentMessages = messages.slice(-(maxMessages - 1));
  const droppedCount = messages.length - maxMessages;

  return {
    messages: [firstMessage, ...recentMessages],
    wasCompressed: true,
    droppedCount,
  };
}

export async function summarizeOldMessages(
  messages: readonly UIMessage[],
  summarizer: Summarizer,
  config: ContextConfig = DEFAULT_CONFIG,
): Promise<CompressionResult> {
  const { maxMessages } = config;

  if (messages.length <= maxMessages) {
    return {
      messages,
      wasCompressed: false,
      droppedCount: 0,
    };
  }

  const firstMessage = messages[0];
  if (firstMessage === undefined) {
    return {
      messages: [],
      wasCompressed: false,
      droppedCount: 0,
    };
  }

  const oldMessages = messages.slice(1, -(maxMessages - 2));
  const recentMessages = messages.slice(-(maxMessages - 2));
  const droppedCount = oldMessages.length;

  const oldContent = oldMessages
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');

  const summary: string = await summarizer(
    `Summarize this conversation history in 2-3 sentences, focusing on key queries and findings:\n${oldContent}`,
  );

  const summaryMessage: UIMessage = {
    id: 'context-summary',
    role: 'assistant',
    content: `[Previous conversation summary: ${summary}]`,
  };

  return {
    messages: [firstMessage, summaryMessage, ...recentMessages],
    wasCompressed: true,
    droppedCount,
  };
}

// Export config type and default
export { DEFAULT_CONFIG };
