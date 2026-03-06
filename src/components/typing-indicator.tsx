'use client';

export function TypingIndicator() {
  return (
    <div className="flex items-center gap-1.5 py-2">
      <span
        className="w-1.5 h-1.5 rounded-full animate-bounce"
        style={{
          backgroundColor: 'var(--gray-400)',
          animationDelay: '0ms',
          animationDuration: '1s',
        }}
      />
      <span
        className="w-1.5 h-1.5 rounded-full animate-bounce"
        style={{
          backgroundColor: 'var(--gray-400)',
          animationDelay: '200ms',
          animationDuration: '1s',
        }}
      />
      <span
        className="w-1.5 h-1.5 rounded-full animate-bounce"
        style={{
          backgroundColor: 'var(--gray-400)',
          animationDelay: '400ms',
          animationDuration: '1s',
        }}
      />
    </div>
  );
}
