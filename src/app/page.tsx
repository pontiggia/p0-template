'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  ChatLayout,
  ChatMessagesContainer,
  ChatInputContainer,
  ChatInput,
  MessageBubble,
  TypingIndicator,
} from '@/components';

export default function ChatPage() {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const userHasScrolledRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const prevMessageCountRef = useRef(0);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: '/api/chat' }),
    [],
  );

  const { messages, sendMessage, status, error } = useChat({ transport });

  const isLoading = status === 'submitted' || status === 'streaming';

  // Track if user manually scrolled up
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // User scrolled UP if scrollTop decreased and they're not near bottom
    if (scrollTop < lastScrollTopRef.current && distanceFromBottom > 150) {
      userHasScrolledRef.current = true;
    }

    // User is back at bottom - reset the flag
    if (distanceFromBottom < 50) {
      userHasScrolledRef.current = false;
    }

    // Show/hide scroll button based on distance from bottom
    setShowScrollButton(distanceFromBottom > 200);

    lastScrollTopRef.current = scrollTop;
  }, []);

  // Add scroll listener
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll, { passive: true });
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  // Auto-scroll only when a NEW message is added (not during streaming updates)
  useEffect(() => {
    const messageCount = messages.length;
    const isNewMessage = messageCount > prevMessageCountRef.current;

    if (isNewMessage && !userHasScrolledRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }

    prevMessageCountRef.current = messageCount;
  }, [messages.length]);

  const handleSubmit = () => {
    if (input.trim() && !isLoading) {
      userHasScrolledRef.current = false; // Reset on new message
      sendMessage({ text: input });
      setInput('');
    }
  };

  const scrollToBottom = useCallback(() => {
    userHasScrolledRef.current = false;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  return (
    <ChatLayout>
      <ChatMessagesContainer ref={scrollContainerRef}>
        {/* Empty state */}
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full min-h-[60vh]">
            <p className="text-[15px]" style={{ color: 'var(--gray-400)' }}>
            </p>
          </div>
        )}

        {/* Messages */}
        <div className="space-y-6">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

          {/* Typing indicator */}
          {isLoading && <TypingIndicator />}

          {/* Scroll anchor */}
          <div ref={messagesEndRef} />
        </div>

        {/* Scroll to bottom button */}
        {showScrollButton && (
          <button
            onClick={scrollToBottom}
            className="fixed bottom-28 right-4 sm:right-8 p-2 rounded-full shadow-lg transition-opacity hover:opacity-80 z-40"
            style={{
              backgroundColor: 'var(--gray-100)',
              border: '1px solid var(--border-color)',
            }}
            aria-label="Scroll to bottom"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ color: 'var(--gray-600)' }}
            >
              <path d="M12 5v14M5 12l7 7 7-7" />
            </svg>
          </button>
        )}

        {/* Error display */}
        {error && (
          <div
            className="mt-4 p-3 rounded-lg text-sm"
            style={{
              backgroundColor: 'var(--accent-50)',
              color: '#dc2626',
              border: '1px solid #fecaca',
            }}
            role="alert"
          >
            {error.message}
          </div>
        )}
      </ChatMessagesContainer>

      <ChatInputContainer>
        <ChatInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          disabled={isLoading}
        />
      </ChatInputContainer>
    </ChatLayout>
  );
}
