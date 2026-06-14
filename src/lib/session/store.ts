import { Redis } from '@upstash/redis';
import type {
  DedupeState,
  PendingAction,
  SessionStore,
  ThreadState,
} from './types';

/**
 * Durable session state for the WhatsApp agent.
 *
 * Uses Upstash Redis when `UPSTASH_REDIS_REST_URL` is set; otherwise falls back
 * to an in-process Map (single-process dev / Sandbox only — NOT durable across
 * cold starts). The interface is identical so the rest of the app is agnostic.
 *
 * Keys: `wa:dedupe:<id>`, `wa:lock:<from>`, `wa:thread:<from>`.
 */

const DEDUPE_PROCESSING_TTL_S = 5 * 60; // a stuck run frees up after 5 min
const DEDUPE_DONE_TTL_S = 24 * 60 * 60; // remember completed deliveries 24h
const LOCK_TTL_S = 120; // safety release if a run dies holding the lock
const THREAD_TTL_S = 24 * 60 * 60; // conversation memory window
export const PENDING_TTL_MS = 10 * 60 * 1000; // confirmation window

const dedupeKey = (id: string) => `wa:dedupe:${id}`;
const lockKey = (from: string) => `wa:lock:${from}`;
const threadKey = (from: string) => `wa:thread:${from}`;

const EMPTY_THREAD: ThreadState = { history: [], pending: null };

/** Drop a pending action that has outlived its TTL. */
function prunePending(state: ThreadState): ThreadState {
  if (state.pending && Date.now() - state.pending.createdAt > PENDING_TTL_MS) {
    return { ...state, pending: null };
  }
  return state;
}

// ── Upstash implementation ──────────────────────────────────────────────────

class UpstashStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  async claimDelivery(key: string): Promise<DedupeState | null> {
    const k = dedupeKey(key);
    const ok = await this.redis.set(k, 'processing', {
      nx: true,
      ex: DEDUPE_PROCESSING_TTL_S,
    });
    if (ok === 'OK') return null; // we claimed it
    return (await this.redis.get<DedupeState>(k)) ?? null;
  }

  async markDeliveryDone(key: string): Promise<void> {
    await this.redis.set(dedupeKey(key), 'done', { ex: DEDUPE_DONE_TTL_S });
  }

  async acquireLock(from: string): Promise<boolean> {
    const ok = await this.redis.set(lockKey(from), '1', {
      nx: true,
      ex: LOCK_TTL_S,
    });
    return ok === 'OK';
  }

  async releaseLock(from: string): Promise<void> {
    await this.redis.del(lockKey(from));
  }

  async getThread(from: string): Promise<ThreadState> {
    const raw = await this.redis.get<ThreadState>(threadKey(from));
    return raw ? prunePending(raw) : EMPTY_THREAD;
  }

  async setThread(from: string, state: ThreadState): Promise<void> {
    await this.redis.set(threadKey(from), state, { ex: THREAD_TTL_S });
  }

  async clearPending(from: string): Promise<void> {
    const current = await this.getThread(from);
    await this.setThread(from, { ...current, pending: null });
  }
}

// ── In-memory fallback ──────────────────────────────────────────────────────

class MemoryStore implements SessionStore {
  private readonly dedupe = new Map<string, { v: DedupeState; exp: number }>();
  private readonly locks = new Map<string, number>();
  private readonly threads = new Map<string, ThreadState>();

  private alive(exp: number): boolean {
    return exp > Date.now();
  }

  async claimDelivery(key: string): Promise<DedupeState | null> {
    const cur = this.dedupe.get(key);
    if (cur && this.alive(cur.exp)) return cur.v;
    this.dedupe.set(key, { v: 'processing', exp: Date.now() + DEDUPE_PROCESSING_TTL_S * 1000 });
    return null;
  }

  async markDeliveryDone(key: string): Promise<void> {
    this.dedupe.set(key, { v: 'done', exp: Date.now() + DEDUPE_DONE_TTL_S * 1000 });
  }

  async acquireLock(from: string): Promise<boolean> {
    const exp = this.locks.get(from);
    if (exp && this.alive(exp)) return false;
    this.locks.set(from, Date.now() + LOCK_TTL_S * 1000);
    return true;
  }

  async releaseLock(from: string): Promise<void> {
    this.locks.delete(from);
  }

  async getThread(from: string): Promise<ThreadState> {
    return prunePending(this.threads.get(from) ?? EMPTY_THREAD);
  }

  async setThread(from: string, state: ThreadState): Promise<void> {
    this.threads.set(from, state);
  }

  async clearPending(from: string): Promise<void> {
    const cur = await this.getThread(from);
    this.threads.set(from, { ...cur, pending: null });
  }
}

// ── Singleton selection ─────────────────────────────────────────────────────

let instance: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (instance) return instance;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  instance = url && token ? new UpstashStore(new Redis({ url, token })) : new MemoryStore();
  return instance;
}

export type { PendingAction };
