import { Pool } from 'pg';

/**
 * Number → primary-key resolution for the WhatsApp agent.
 *
 * The `/api/v1` surface has no path from a bare "venta 4123" / "pago 88" to the
 * internal PK that every mutation + `getSale` keys on. We resolve it with two
 * deterministic, parameterized, `store_id`-scoped lookups over a **read-only**
 * `pg` connection (same `DATABASE_URL` / read-only role as the analytics path).
 *
 * `local_id` is per-store unique, so the store id is required. It comes from
 * `PONTIMPO_STORE_ID` (set it for the agent even when the API credential is
 * store-bound — the DB query needs the store explicitly).
 */

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL must be set');
    pool = new Pool({ connectionString, max: 2 });
  }
  return pool;
}

function storeId(): number {
  const raw = process.env.PONTIMPO_STORE_ID;
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n <= 0) {
    throw new Error('PONTIMPO_STORE_ID must be a positive integer for number→PK resolution');
  }
  return n;
}

/** Sale `local_id` → internal sale id (store-scoped). Null if not found. */
export async function resolveSaleByNumber(localId: number): Promise<number | null> {
  const { rows } = await getPool().query<{ id: number }>(
    'SELECT id FROM sale WHERE local_id = $1 AND store_id = $2',
    [localId, storeId()],
  );
  return rows[0]?.id ?? null;
}

/**
 * Payment `local_id` → internal client_ledger_entry id (store-scoped,
 * `kind='payment'`). Null if not found / not a payment.
 */
export async function resolveLedgerEntryByNumber(localId: number): Promise<number | null> {
  const { rows } = await getPool().query<{ id: number }>(
    "SELECT id FROM client_ledger_entry WHERE local_id = $1 AND store_id = $2 AND kind = 'payment'",
    [localId, storeId()],
  );
  return rows[0]?.id ?? null;
}
