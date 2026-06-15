import type { SessionStore } from './types';

/**
 * Acquire the per-sender lock, retrying briefly so two rapid messages from the
 * same number serialize instead of racing on history/pending. Returns false if
 * the lock couldn't be taken within the budget (caller should drop politely).
 */
export async function withSenderLock<T>(
  store: SessionStore,
  from: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<{ ran: true; value: T } | { ran: false }> {
  const attempts = opts.attempts ?? 20;
  const delayMs = opts.delayMs ?? 250;

  let acquired = false;
  for (let i = 0; i < attempts; i++) {
    if (await store.acquireLock(from)) {
      acquired = true;
      break;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  if (!acquired) return { ran: false };

  try {
    return { ran: true, value: await fn() };
  } finally {
    await store.releaseLock(from);
  }
}
