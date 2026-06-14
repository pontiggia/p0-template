import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Kapso webhook signature.
 *
 * Kapso sends `X-Webhook-Signature` = HMAC-SHA256, hex-encoded, computed over
 * the **raw** request body bytes using the per-webhook signing secret. We must
 * verify against the raw body (never a re-serialized object) and compare in
 * constant time.
 *
 * @param rawBody   the exact request body string as received
 * @param signature the `X-Webhook-Signature` header value
 * @param secret    `KAPSO_WEBHOOK_SECRET`
 */
export function verifyKapsoSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !secret) return false;

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

  // Hex strings of differing length can't match; timingSafeEqual throws on
  // length mismatch, so guard first (the length itself isn't a secret).
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || sigBuf.length === 0) return false;

  return timingSafeEqual(sigBuf, expBuf);
}
