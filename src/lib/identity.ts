/**
 * Staff allowlist: WhatsApp number → stable identity used for `on_behalf_of`.
 *
 * Sourced from `STAFF_ALLOWLIST` (JSON map). Unknown numbers get zero tool
 * calls and a polite Spanish refusal (handled by the caller). `on_behalf_of` is
 * required on every correction; an unresolved sender cannot correct anything.
 *
 *   STAFF_ALLOWLIST={"5492916123456":{"staffName":"Oscar","onBehalfOf":"oscar@lasflores.com"}}
 */

export interface StaffIdentity {
  readonly staffName: string;
  readonly onBehalfOf: string;
}

let cache: Record<string, StaffIdentity> | null = null;

function load(): Record<string, StaffIdentity> {
  if (cache) return cache;
  const raw = process.env.STAFF_ALLOWLIST;
  if (!raw) {
    cache = {};
    return cache;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<StaffIdentity>>;
    const out: Record<string, StaffIdentity> = {};
    for (const [number, id] of Object.entries(parsed)) {
      if (id && typeof id.staffName === 'string' && typeof id.onBehalfOf === 'string') {
        out[normalizeNumber(number)] = { staffName: id.staffName, onBehalfOf: id.onBehalfOf };
      }
    }
    cache = out;
  } catch {
    console.error('[identity] STAFF_ALLOWLIST is not valid JSON; treating as empty');
    cache = {};
  }
  return cache;
}

/** Strip everything but digits so "+54 9 291…" and "54929…" match. */
function normalizeNumber(n: string): string {
  return n.replace(/\D/g, '');
}

/** Returns the identity for an allowlisted WhatsApp number, or null. */
export function resolveStaff(from: string): StaffIdentity | null {
  return load()[normalizeNumber(from)] ?? null;
}

/** Test/hot-reload helper. */
export function resetIdentityCache(): void {
  cache = null;
}
