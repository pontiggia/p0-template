'use client';

import type { UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { MarkdownRenderer } from '@/components/chat';
import { ChartDisplay } from '@/components/chat/chart-display';

interface TextPart {
  type: 'text';
  text: string;
}

interface ToolPart {
  type: string;
  toolCallId: string;
  state: 'partial-call' | 'call' | 'output-available';
  input?: Record<string, unknown>;
  output?: unknown;
}

interface NormalizedToolInvocation {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  state: 'partial-call' | 'call' | 'result';
  result?: unknown;
}

type MessagePart = TextPart | ToolPart | { type: string };

function getMessageText(message: UIMessage): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts = (message as any).parts as MessagePart[] | undefined;
  if (!parts) return '';

  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

function getToolInvocations(message: UIMessage): NormalizedToolInvocation[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts = (message as any).parts as MessagePart[] | undefined;
  if (!parts) return [];

  return parts
    .filter((part): part is ToolPart => part.type.startsWith('tool-'))
    .map((part) => {
      const toolName = part.type.replace('tool-', '');
      const state = part.state === 'output-available' ? 'result' : part.state;

      return {
        toolCallId: part.toolCallId,
        toolName,
        args: part.input,
        state,
        result: part.output,
      };
    });
}

interface ToolCallDisplayProps {
  readonly tool: NormalizedToolInvocation;
}

function ToolCallDisplay({ tool }: ToolCallDisplayProps): ReactNode {
  const isCommand = tool.toolName === 'executeCommand';
  const isSQL = tool.toolName === 'executeSQL';
  const isChart = tool.toolName === 'generateChart';

  if (isChart) {
    return <ChartDisplay tool={tool} />;
  }

  if (isCommand) {
    return null;
  }

  if (isSQL) {
    return null;
  }

  return null;
}

interface MessageBubbleProps {
  readonly message: UIMessage;
}

export function MessageBubble({ message }: MessageBubbleProps): ReactNode {
  const isUser = message.role === 'user';
  const textContent = getMessageText(message);
  const toolInvocations = getToolInvocations(message);

  if (isUser) {
    return (
      <div className="flex justify-end min-w-0">
        <div
          className="max-w-[90%] sm:max-w-[85%] px-3 sm:px-4 py-2.5 sm:py-3 rounded-2xl"
          style={{
            backgroundColor: 'var(--accent-50)',
            color: 'var(--foreground)',
          }}
        >
          <p className="whitespace-pre-wrap text-[14px] sm:text-[15px] leading-relaxed break-words">
            {textContent}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start min-w-0">
      <div className="max-w-[95%] sm:max-w-[85%] min-w-0 overflow-hidden">
        {toolInvocations.length > 0 && (
          <div className="mb-2">
            {toolInvocations.map((tool) => (
              <ToolCallDisplay key={tool.toolCallId} tool={tool} />
            ))}
          </div>
        )}
        {textContent && <MarkdownRenderer content={textContent} />}
      </div>
    </div>
  );
}
