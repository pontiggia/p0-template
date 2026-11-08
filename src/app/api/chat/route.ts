import {
  streamText,
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  toUIMessageStream,
  type UIMessage,
} from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { agentTools } from '@/lib/tools';
import { SYSTEM_PROMPT } from '@/lib/system-prompt';
import type { NextRequest } from 'next/server';

const MODEL_ID = 'claude-opus-4-5-20251101' as const;

export const maxDuration: number = 180;

const MAX_RETRIES = 3;

export async function POST(req: NextRequest): Promise<Response> {
  console.log('[Chat API] Tools available:', Object.keys(agentTools));

  try {
    const body = await req.json();
    const { messages } = body as { messages: UIMessage[] };

    const modelMessages = await convertToModelMessages(messages);

    // v7 rejects system messages inside `messages`; the prompt (with its
    // cache breakpoint) goes in `instructions`.
    const result = streamText({
      model: anthropic(MODEL_ID),
      instructions: {
        role: 'system',
        content: SYSTEM_PROMPT,
        providerOptions: {
          anthropic: { cacheControl: { type: 'ephemeral' } },
        },
      },
      messages: modelMessages,
      tools: agentTools,
      maxRetries: MAX_RETRIES,
      stopWhen: isStepCount(15),
    });

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({ stream: result.stream }),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('429')) {
      console.error('[Chat API] Rate limit exceeded:', error.message);
      return new Response(
        JSON.stringify({
          error: 'Rate limit exceeded. Please wait a moment and try again.',
          retryAfter: 60,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '60',
          },
        },
      );
    }

    console.error('[Chat API] Unexpected error:', error);
    return new Response(
      JSON.stringify({ error: 'An unexpected error occurred' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
