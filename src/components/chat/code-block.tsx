'use client';

import { useState, useCallback, type ReactNode } from 'react';

interface CodeBlockProps {
  readonly children: ReactNode;
  readonly className?: string;
}

function extractLanguage(className?: string): string | null {
  if (!className) return null;
  const match = className.match(/language-(\w+)/);
  return match ? match[1] : null;
}

function CopyButton({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available, fail silently
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors"
      style={{
        color: 'var(--gray-500)',
        backgroundColor: 'transparent',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = 'var(--gray-200)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent';
      }}
      type="button"
      aria-label={copied ? 'Copied!' : 'Copy code'}
    >
      {copied ? (
        <>
          <CheckIcon />
          <span>Copied!</span>
        </>
      ) : (
        <>
          <CopyIcon />
          <span>Copy</span>
        </>
      )}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function CodeBlock({ children, className }: CodeBlockProps): ReactNode {
  const language = extractLanguage(className);

  // Extract text content from children for copy functionality
  const textContent = extractTextContent(children);

  return (
    <div
      className="relative my-3 rounded-lg overflow-hidden"
      style={{
        backgroundColor: 'var(--gray-100)',
        border: '1px solid var(--border-color)',
      }}
    >
      {/* Header with language badge and copy button */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{
          borderBottom: '1px solid var(--border-color)',
          backgroundColor: 'var(--gray-50)',
        }}
      >
        <span
          className="text-xs font-medium"
          style={{ color: 'var(--gray-500)' }}
        >
          {language ?? 'code'}
        </span>
        <CopyButton text={textContent} />
      </div>

      {/* Code content */}
      <pre
        className="overflow-x-auto p-4 m-0 text-[13px] leading-relaxed"
        style={{
          backgroundColor: 'var(--gray-100)',
          maxHeight: '400px',
        }}
      >
        <code
          className={className}
          style={{
            fontFamily: 'var(--font-geist-mono), monospace',
            color: 'var(--foreground)',
          }}
        >
          {children}
        </code>
      </pre>
    </div>
  );
}

function extractTextContent(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node) return '';

  if (Array.isArray(node)) {
    return node.map(extractTextContent).join('');
  }

  if (typeof node === 'object' && 'props' in node) {
    return extractTextContent((node as { props: { children?: ReactNode } }).props.children);
  }

  return '';
}

export function InlineCode({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <code
      className="px-1.5 py-0.5 rounded text-[0.9em]"
      style={{
        fontFamily: 'var(--font-geist-mono), monospace',
        backgroundColor: 'var(--gray-100)',
        color: 'var(--foreground)',
      }}
    >
      {children}
    </code>
  );
}
