/**
 * Types for the Pontimpo `/api/v1` contract.
 *
 * Derived from `pontimpo-tire-system/openapi.json` (generated from the app's Zod
 * schemas) and verified against the route-handler source. When the generated
 * spec and these types disagree, the spec wins — regenerate from it.
 *
 * Money is integer **centavos** at the API boundary. USD-denominated entries
 * carry the ARS value in `amount_centavos` plus `amount_usd_centavos` +
 * `fx_rate_centavos`.
 */

export const PAYMENT_METHODS = [
  'efectivo',
  'credito',
  'debito',
  'transferencia',
  'cheque',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type Currency = 'ARS' | 'USD';
export type SaleStatus = 'pending' | 'paid' | 'cancelled' | 'refunded';

/** Error envelope: `code` is a stable English token, `message` is es-AR. */
export interface ApiError {
  readonly code: string;
  readonly message: string;
}

// ── Reads ──────────────────────────────────────────────────────────────────

export interface ClientSummary {
  readonly id: number;
  readonly local_id: number;
  readonly name: string;
  readonly phone: string | null;
  readonly debt_centavos: number;
}

export interface ClientDetail extends ClientSummary {
  readonly email: string | null;
  readonly dni: string | null;
  readonly address: string | null;
  readonly notes: string | null;
  readonly max_pending_sales: number | null;
  readonly credit_exempt: boolean;
}

export interface SaleItem {
  readonly id: number;
  readonly kind: 'product' | 'service';
  readonly product_id: number | null;
  readonly service_id: number | null;
  readonly description: string;
  /** description + the product's details (size/brand) — what the staff calls it */
  readonly display_description?: string;
  readonly quantity: number;
  readonly unit_price_centavos: number;
  readonly list_price_centavos: number;
  readonly total_centavos: number;
}

export interface LedgerEntry {
  readonly id: number;
  readonly kind: string; // 'sale' | 'payment' | 'adjustment' | 'cancellation' | 'refund' | ...
  readonly amount_centavos: number;
  readonly currency: Currency;
  readonly amount_usd_centavos: number | null;
  readonly fx_rate_centavos: number | null;
  readonly payment_method: PaymentMethod | null;
  readonly entry_date: string;
  readonly description: string | null;
  /** present on sale-scoped ledger; null until reversed (R11) */
  readonly reverses_entry_id?: number | null;
  readonly reversed_by_entry_id?: number | null;
  readonly local_id?: number | null;
}

export interface SaleDetail {
  readonly id: number;
  readonly local_id: number;
  readonly sale_date: string;
  readonly status: SaleStatus;
  readonly client_id: number;
  readonly client_name: string;
  readonly seller_name: string;
  readonly total_centavos: number;
  readonly paid_centavos: number;
  readonly is_invoiced: boolean;
  readonly notes: string | null;
  readonly debt_centavos: number;
  readonly items: readonly SaleItem[];
  readonly ledger: readonly LedgerEntry[];
}

export interface SaleListRow {
  readonly id: number;
  readonly local_id: number;
  readonly sale_date: string;
  readonly status: SaleStatus;
  readonly client_id: number;
  readonly client_name: string;
  readonly total_centavos: number;
  readonly debt_centavos: number;
}

export interface ClientLedgerRow {
  readonly id: number;
  readonly kind: string;
  readonly amount_centavos: number;
  readonly entry_date: string;
  readonly description: string | null;
  readonly payment_method: PaymentMethod | null;
  readonly sale_id: number | null;
  readonly sale_local_id: number | null;
}

/** `GET /products` row (`products:read`) — R12 needs the replacement product. */
export interface ProductRow {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly details: string | null;
  readonly is_tire: boolean;
  readonly location: string | null;
  readonly quantity_on_hand: number;
  readonly is_active: boolean;
  readonly price_centavos: number;
  readonly cost_centavos: number;
}

export interface Paginated<T> {
  readonly data: readonly T[];
  readonly next_cursor: string | null;
}

export interface AuditEvent {
  readonly id: number;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: number;
  readonly created_at: string;
  readonly on_behalf_of: string | null;
}

// ── Mutation request bodies (exact shapes from openapi.json) ────────────────

/** R5 — cancel an unpaid sale. */
export interface CancelSaleBody {
  readonly reason: string;
  readonly on_behalf_of: string;
}

/** R6 — refund a paid sale. */
export interface RefundSaleBody {
  readonly method: PaymentMethod;
  readonly restock?: ReadonlyArray<{ sale_item_id: number; restock: boolean }>;
  readonly reason: string;
  readonly on_behalf_of: string;
}

/** R7 — correct sale amounts (prices only). */
export interface CorrectSaleBody {
  readonly expected_current_total_centavos: number;
  readonly lines: ReadonlyArray<{ sale_item_id: number; unit_price_centavos: number }>;
  readonly reason: string;
  readonly on_behalf_of: string;
}

/** R11 — reverse a registered payment (sale-linked or client-level). */
export interface ReversePaymentBody {
  readonly reason: string;
  readonly on_behalf_of: string;
}

/** R12 — swap the product on a sale line. */
export interface LineSwapBody {
  readonly sale_item_id: number;
  readonly new_product_id: number;
  readonly new_unit_price_centavos?: number;
  readonly expected_current_total_centavos: number;
  readonly reason: string;
  readonly on_behalf_of: string;
}

/**
 * R2 — register a payment on a sale. NOTE: no `on_behalf_of` field — the API
 * stamps the credential; we tag the staff name + correlation id into
 * `description`. `full: true` is ARS-only; for USD send the explicit triple.
 */
export interface SalePaymentBody {
  readonly payment_method: PaymentMethod;
  readonly description?: string;
  readonly full?: boolean;
  readonly currency?: Currency;
  readonly amount_centavos?: number;
  readonly amount_usd_centavos?: number;
  readonly fx_rate_centavos?: number;
}

/** R4 — register a client-level payment. Same attribution caveat as R2. */
export interface ClientPaymentBody {
  readonly payment_method: PaymentMethod;
  readonly description?: string;
  readonly currency?: Currency;
  readonly amount_centavos?: number;
  readonly amount_usd_centavos?: number;
  readonly fx_rate_centavos?: number;
}
