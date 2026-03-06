'use client';

import { forwardRef, type ReactNode } from 'react';

interface ChatLayoutProps {
  readonly children: ReactNode;
}

export function ChatLayout({ children }: ChatLayoutProps) {
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: 'var(--background)' }}
    >
      {/* Header with subtle branding */}
      <header
        className="flex-shrink-0 px-4 py-3 border-b"
        style={{ borderColor: 'var(--border-color)' }}
      >
        <span
          className="font-mono text-sm font-medium"
          style={{ color: 'var(--gray-500)' }}
        >
          d0 Agent
        </span>
      </header>

      {/* Main content area */}
      <main className="flex-1 flex flex-col overflow-hidden">{children}</main>
    </div>
  );
}

interface ChatMessagesContainerProps {
  readonly children: ReactNode;
}

export const ChatMessagesContainer = forwardRef<
  HTMLDivElement,
  ChatMessagesContainerProps
>(({ children }, ref) => {
  return (
    <div ref={ref} className="flex-1 overflow-y-auto overflow-x-hidden pb-28">
      <div className="max-w-[800px] mx-auto px-3 sm:px-4 py-4 sm:py-6 min-w-0">
        {children}
      </div>
    </div>
  );
});
ChatMessagesContainer.displayName = 'ChatMessagesContainer';

interface ChatInputContainerProps {
  readonly children: ReactNode;
}

export function ChatInputContainer({ children }: ChatInputContainerProps) {
  return (
    <div
      className="fixed bottom-0 left-0 right-0 border-t z-50"
      style={{
        borderColor: 'var(--border-color)',
        backgroundColor: 'var(--background)',
      }}
    >
      <div className="max-w-[800px] mx-auto px-3 sm:px-4 py-3 sm:py-4 min-w-0">
        {children}
      </div>
    </div>
  );
}
