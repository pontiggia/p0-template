'use client';

import { type FormEvent, type KeyboardEvent, useRef, useEffect } from 'react';

interface ChatInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = 'Escribe un mensaje...',
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      // Temporarily disable transition for accurate measurement
      textarea.style.transition = 'none';
      textarea.style.height = 'auto';
      const scrollHeight = textarea.scrollHeight;
      const newHeight = Math.max(24, Math.min(scrollHeight, 200));
      textarea.style.height = `${newHeight}px`;
      // Re-enable transition after a frame
      requestAnimationFrame(() => {
        textarea.style.transition = '';
      });
    }
  }, [value]);

  // Focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (value.trim() && !disabled) {
      onSubmit();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter to send, Shift+Enter for newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !disabled) {
        onSubmit();
      }
    }
  };

  return (
    <form onSubmit={handleSubmit} className="relative">
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-2xl border transition-colors"
        style={{
          backgroundColor: 'var(--gray-100)',
          borderColor: 'var(--gray-200)',
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none bg-transparent outline-none text-[15px] leading-[1.5] transition-[height] duration-150 ease-out"
          style={{
            color: 'var(--foreground)',
            maxHeight: '200px',
          }}
          aria-label="Message input"
        />
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full transition-all disabled:opacity-40"
          style={{
            backgroundColor:
              disabled || !value.trim()
                ? 'var(--gray-200)'
                : 'var(--foreground)',
            color:
              disabled || !value.trim()
                ? 'var(--gray-400)'
                : 'var(--background)',
          }}
          aria-label="Send message"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </svg>
        </button>
      </div>
    </form>
  );
}
