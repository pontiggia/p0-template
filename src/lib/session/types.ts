import type { ModelMessage } from 'ai';

/** A single API mutation staged at plan time, executed only after confirm. */
export interface PlannedStep {
  /** which Pontimpo call this is, e.g. 'reversePayment' | 'registerSalePayment' */
  readonly call: string;
  /** path relative to /api/v1, e.g. '/ledger-entries/123/reverse' */
  readonly path: string;
  /** the exact JSON body to POST (already includes on_behalf_of / description) */
  readonly body: Record<string, unknown>;
  /** stable idempotency key, minted at plan time, reused on execute/redelivery */
  readonly idempotencyKey: string;
  /** human-readable es-AR line rendered from the structured body */
  readonly summary: string;
  /** for R7/R12: the expected_current_total snapshot used for the optimistic check */
  readonly expectedTotalSnapshot?: number;
}

export interface PendingAction {
  /** correlation id embedded into every step's description/reason */
  readonly corrId: string;
  /** the ordered steps to execute on confirmation */
  readonly steps: readonly PlannedStep[];
  /** epoch ms when this was created (TTL is enforced by the store) */
  readonly createdAt: number;
}

export interface ThreadState {
  /** trimmed model message history for this WhatsApp thread */
  readonly history: ModelMessage[];
  /** a correction awaiting confirmation, if any */
  readonly pending: PendingAction | null;
}

export type DedupeState = 'processing' | 'done';

export interface SessionStore {
  // ── webhook delivery dedupe ──
  /** SETNX dedupe key → 'processing'. Returns the existing value if already set. */
  claimDelivery(key: string): Promise<DedupeState | null>;
  markDeliveryDone(key: string): Promise<void>;

  // ── per-sender lock (serialize async runs for one number) ──
  acquireLock(from: string): Promise<boolean>;
  releaseLock(from: string): Promise<void>;

  // ── thread state ──
  getThread(from: string): Promise<ThreadState>;
  setThread(from: string, state: ThreadState): Promise<void>;
  clearPending(from: string): Promise<void>;
}
