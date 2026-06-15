import type {
  ApiError,
  AuditEvent,
  ClientDetail,
  ClientLedgerRow,
  ClientSummary,
  Paginated,
  SaleDetail,
  SaleListRow,
} from './types';

/**
 * Typed client for the Pontimpo `/api/v1` API.
 *
 * - `Authorization: Bearer <PONTIMPO_API_KEY>`
 * - `X-Store-Id` only when the credential is store-unbound (`PONTIMPO_STORE_ID`)
 * - POSTs carry a caller-supplied `Idempotency-Key`
 * - errors surface as `PontimpoApiError` carrying the `{code, message}` envelope
 *   (message is es-AR and safe to show the user)
 */

const PONTIMPO_ERROR_MARKER = '__isPontimpoApiError';

export class PontimpoApiError extends Error {
  /** Stable marker so detection survives duplicate module instances (instanceof
   *  is unreliable across bundler/tsx boundaries). */
  readonly [PONTIMPO_ERROR_MARKER] = true as const;

  constructor(
    readonly code: string,
    /** es-AR, user-safe */
    readonly userMessage: string,
    readonly status: number,
  ) {
    super(`${code}: ${userMessage}`);
    this.name = 'PontimpoApiError';
  }

  static is(err: unknown): err is PontimpoApiError {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as Record<string, unknown>)[PONTIMPO_ERROR_MARKER] === true
    );
  }
}

function baseUrl(): string {
  const url = process.env.PONTIMPO_API_URL;
  if (!url) throw new Error('PONTIMPO_API_URL must be set');
  return `${url.replace(/\/$/, '')}/api/v1`;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const key = process.env.PONTIMPO_API_KEY;
  if (!key) throw new Error('PONTIMPO_API_KEY must be set');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
  const storeId = process.env.PONTIMPO_STORE_ID;
  if (storeId) headers['X-Store-Id'] = storeId;
  return headers;
}

async function toError(res: Response): Promise<PontimpoApiError> {
  let code = 'INTERNAL';
  let message = 'Algo salió mal, intenta de nuevo';
  try {
    const body = (await res.json()) as Partial<ApiError>;
    if (body.code) code = body.code;
    if (body.message) message = body.message;
  } catch {
    // non-JSON error body; keep defaults
  }
  return new PontimpoApiError(code, message, res.status);
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'GET',
    headers: authHeaders(),
    cache: 'no-store',
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export interface PostResult<T> {
  readonly data: T;
  /** true when the API replayed a stored response (Idempotency-Replay header) */
  readonly replayed: boolean;
}

/**
 * POST a mutation with a required idempotency key. Used only by
 * `executePendingAction` — mutation *tools* never call this at plan time.
 */
export async function apiPost<T>(
  path: string,
  body: unknown,
  idempotencyKey: string,
): Promise<PostResult<T>> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: authHeaders({ 'Idempotency-Key': idempotencyKey }),
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw await toError(res);
  const replayed = res.headers.get('Idempotency-Replay') === 'true';
  return { data: (await res.json()) as T, replayed };
}

// ── Read helpers (correction targeting) ─────────────────────────────────────

export function getClients(search: string): Promise<Paginated<ClientSummary>> {
  return apiGet(`/clients?search=${encodeURIComponent(search)}`);
}

export function getClient(id: number): Promise<ClientDetail> {
  return apiGet(`/clients/${id}`);
}

export function getClientLedger(id: number): Promise<Paginated<ClientLedgerRow>> {
  return apiGet(`/clients/${id}/ledger`);
}

export function getSale(id: number): Promise<SaleDetail> {
  return apiGet(`/sales/${id}`);
}

export interface SaleFilters {
  status?: string;
  clientId?: number;
  from?: string;
  to?: string;
  soldBy?: string;
}

export function getSales(filters: SaleFilters): Promise<Paginated<SaleListRow>> {
  const q = new URLSearchParams();
  if (filters.status) q.set('status', filters.status);
  if (filters.clientId != null) q.set('client_id', String(filters.clientId));
  if (filters.from) q.set('from', filters.from);
  if (filters.to) q.set('to', filters.to);
  if (filters.soldBy) q.set('sold_by', filters.soldBy);
  const qs = q.toString();
  return apiGet(`/sales${qs ? `?${qs}` : ''}`);
}

export interface AuditFilters {
  entityType?: string;
  entityId?: number;
  action?: string;
}

export function getAuditEvents(filters: AuditFilters): Promise<Paginated<AuditEvent>> {
  const q = new URLSearchParams();
  if (filters.entityType) q.set('entity', filters.entityType);
  if (filters.entityId != null) q.set('entity_id', String(filters.entityId));
  if (filters.action) q.set('action', filters.action);
  const qs = q.toString();
  return apiGet(`/audit-events${qs ? `?${qs}` : ''}`);
}
