'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { ReactNode, ComponentPropsWithoutRef } from 'react';
import { sanitizeSchema, remarkGfmOptions } from '@/lib/markdown/config';
import { CodeBlock, InlineCode } from './code-block';

interface MarkdownRendererProps {
  readonly content: string;
}

// Custom components for markdown elements
const components = {
  // Code blocks and inline code
  code: ({
    className,
    children,
    ...props
  }: ComponentPropsWithoutRef<'code'> & { inline?: boolean }) => {
    // Check if this is a code block (inside pre) or inline code
    // react-markdown wraps code blocks in <pre><code>, so we detect
    // by checking if parent will be pre (className with language-)
    const isCodeBlock = className?.includes('language-');

    if (isCodeBlock) {
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }

    return <InlineCode>{children}</InlineCode>;
  },

  // Override pre to just pass through children (CodeBlock handles the wrapper)
  pre: ({ children }: ComponentPropsWithoutRef<'pre'>) => {
    return <>{children}</>;
  },

  // Links with security attributes
  a: ({ href, children }: ComponentPropsWithoutRef<'a'>) => {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-0.5"
        style={{ color: 'var(--accent-500)' }}
      >
        {children}
        <ExternalLinkIcon />
      </a>
    );
  },

  // Downscaled headings for chat context
  h1: ({ children }: ComponentPropsWithoutRef<'h1'>) => (
    <p
      className="font-semibold mb-2 mt-4 first:mt-0"
      style={{ fontSize: '16px', color: 'var(--foreground)' }}
    >
      {children}
    </p>
  ),
  h2: ({ children }: ComponentPropsWithoutRef<'h2'>) => (
    <p
      className="font-semibold mb-2 mt-3 first:mt-0"
      style={{ fontSize: '15px', color: 'var(--foreground)' }}
    >
      {children}
    </p>
  ),
  h3: ({ children }: ComponentPropsWithoutRef<'h3'>) => (
    <p
      className="font-medium mb-2 mt-3 first:mt-0"
      style={{ fontSize: '14px', color: 'var(--foreground)' }}
    >
      {children}
    </p>
  ),
  h4: ({ children }: ComponentPropsWithoutRef<'h4'>) => (
    <p className="font-medium mb-1 mt-2 first:mt-0" style={{ fontSize: '14px', color: 'var(--foreground)' }}>
      {children}
    </p>
  ),
  h5: ({ children }: ComponentPropsWithoutRef<'h5'>) => (
    <p className="font-medium mb-1 mt-2 first:mt-0" style={{ fontSize: '14px', color: 'var(--foreground)' }}>
      {children}
    </p>
  ),
  h6: ({ children }: ComponentPropsWithoutRef<'h6'>) => (
    <p className="font-medium mb-1 mt-2 first:mt-0" style={{ fontSize: '14px', color: 'var(--foreground)' }}>
      {children}
    </p>
  ),

  // Paragraphs
  p: ({ children }: ComponentPropsWithoutRef<'p'>) => (
    <p
      className="mb-3 last:mb-0 text-[15px] leading-relaxed"
      style={{ color: 'var(--foreground)' }}
    >
      {children}
    </p>
  ),

  // Lists
  ul: ({ children }: ComponentPropsWithoutRef<'ul'>) => (
    <ul className="list-disc pl-5 mb-3 space-y-1" style={{ color: 'var(--foreground)' }}>
      {children}
    </ul>
  ),
  ol: ({ children }: ComponentPropsWithoutRef<'ol'>) => (
    <ol className="list-decimal pl-5 mb-3 space-y-1" style={{ color: 'var(--foreground)' }}>
      {children}
    </ol>
  ),
  li: ({ children }: ComponentPropsWithoutRef<'li'>) => (
    <li className="text-[15px] leading-relaxed">{children}</li>
  ),

  // Blockquotes
  blockquote: ({ children }: ComponentPropsWithoutRef<'blockquote'>) => (
    <blockquote
      className="pl-4 py-2 my-3 rounded-r"
      style={{
        borderLeft: '3px solid var(--gray-300)',
        backgroundColor: 'var(--gray-50)',
        color: 'var(--gray-600)',
      }}
    >
      {children}
    </blockquote>
  ),

  // Tables
  table: ({ children }: ComponentPropsWithoutRef<'table'>) => (
    <div className="overflow-x-auto my-3" style={{ maxHeight: '300px' }}>
      <table
        className="w-full text-sm"
        style={{
          borderCollapse: 'collapse',
          border: '1px solid var(--border-color)',
        }}
      >
        {children}
      </table>
    </div>
  ),
  thead: ({ children }: ComponentPropsWithoutRef<'thead'>) => (
    <thead style={{ backgroundColor: 'var(--gray-100)' }}>{children}</thead>
  ),
  tbody: ({ children }: ComponentPropsWithoutRef<'tbody'>) => (
    <tbody>{children}</tbody>
  ),
  tr: ({ children }: ComponentPropsWithoutRef<'tr'>) => (
    <tr style={{ borderBottom: '1px solid var(--border-color)' }}>{children}</tr>
  ),
  th: ({ children }: ComponentPropsWithoutRef<'th'>) => (
    <th
      className="px-3 py-2 text-left font-semibold"
      style={{
        borderRight: '1px solid var(--border-color)',
        color: 'var(--foreground)',
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }: ComponentPropsWithoutRef<'td'>) => (
    <td
      className="px-3 py-2"
      style={{
        borderRight: '1px solid var(--border-color)',
        color: 'var(--foreground)',
      }}
    >
      {children}
    </td>
  ),

  // Horizontal rule
  hr: () => (
    <hr
      className="my-4"
      style={{ border: 'none', borderTop: '1px solid var(--border-color)' }}
    />
  ),

  // Strong and emphasis
  strong: ({ children }: ComponentPropsWithoutRef<'strong'>) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }: ComponentPropsWithoutRef<'em'>) => (
    <em className="italic">{children}</em>
  ),
  del: ({ children }: ComponentPropsWithoutRef<'del'>) => (
    <del className="line-through">{children}</del>
  ),
};

function ExternalLinkIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block ml-0.5"
      style={{ opacity: 0.7 }}
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

export function MarkdownRenderer({ content }: MarkdownRendererProps): ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={[[remarkGfm, remarkGfmOptions]]}
      rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}
