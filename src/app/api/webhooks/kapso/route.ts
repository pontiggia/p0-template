import { waitUntil } from '@vercel/functions';
import type { NextRequest } from 'next/server';
import { verifyKapsoSignature } from '@/lib/whatsapp/verify';
import { parseInbound, type InboundMessage } from '@/lib/whatsapp/inbound';
import { sendText } from '@/lib/whatsapp/client';
import { getSessionStore } from '@/lib/session/store';
import { processInbound } from '@/lib/agent/process';

// Node runtime (crypto + pg). Must match/exceed the chat route's budget so
// waitUntil work isn't killed mid-flight.
export const runtime = 'nodejs';
export const maxDuration = 180;

const SIGNATURE_HEADER = 'x-webhook-signature';
const DEDUPE_HEADER = 'x-idempotency-key';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  // 1. Read the RAW body (signature is computed over these exact bytes).
  const rawBody = await req.text();

  // 2. Verify signature before doing anything else.
  const secret = process.env.KAPSO_WEBHOOK_SECRET ?? '';
  const signature = req.headers.get(SIGNATURE_HEADER);
  if (!verifyKapsoSignature(rawBody, signature, secret)) {
    return json({ error: 'invalid signature' }, 401);
  }

  // 3. Parse (raw → object) only after the signature checks out.
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const inbound = parseInbound(payload);
  if (!inbound) {
    // Not a text/button we handle (delivery receipts, etc.) — ack and ignore.
    return json({ ignored: true });
  }

  // 4. Dedupe on the delivery id. Short-circuit only when already `done` or a
  //    fresh `processing` (a stale/failed run is allowed to re-process).
  const store = getSessionStore();
  const deliveryId =
    req.headers.get(DEDUPE_HEADER) ?? `${inbound.from}:${inbound.messageId}`;
  const existing = await store.claimDelivery(deliveryId);
  if (existing === 'done' || existing === 'processing') {
    return json({ duplicate: true });
  }

  // 5. Ack immediately; process asynchronously. The reply goes out via the
  //    Kapso send API, never via this response.
  waitUntil(processMessage(inbound, deliveryId));
  return json({ ok: true });
}

/**
 * Async pipeline: identity → lock → load thread → confirm/cancel/agent →
 * persist → reply (all in processInbound). A thrown error always yields a
 * generic es-AR message; the dedupe key is marked `done` so a redelivery of the
 * same message doesn't reprocess (per-step idempotency keys make a re-confirm
 * safe regardless).
 */
async function processMessage(
  inbound: InboundMessage,
  deliveryId: string,
): Promise<void> {
  const store = getSessionStore();
  try {
    await processInbound(inbound);
  } catch (err) {
    console.error('[kapso webhook] processing error:', err);
    try {
      await sendText(inbound.from, 'Algo salió mal, pedímelo de nuevo.');
    } catch {
      // sending the error message also failed — nothing else to do
    }
  } finally {
    await store.markDeliveryDone(deliveryId);
  }
}
