/**
 * Minimal Kapso WhatsApp send client (REST proxy over the Meta Cloud API).
 *
 *   POST {BASE}/v24.0/{phoneNumberId}/messages   header: X-API-Key
 *
 * We send text, interactive reply buttons (max 3, title ≤20 chars), and
 * mark-read. Replies always go out via this API — never via the webhook HTTP
 * response.
 */

const DEFAULT_BASE_URL = 'https://api.kapso.ai/meta/whatsapp';

export interface ReplyButton {
  /** stable id echoed back in `interactive.button_reply.id` */
  readonly id: string;
  /** label shown to the user; truncated to 20 chars by WhatsApp */
  readonly title: string;
}

interface KapsoConfig {
  readonly apiKey: string;
  readonly phoneNumberId: string;
  readonly baseUrl?: string;
}

function config(): KapsoConfig {
  const apiKey = process.env.KAPSO_API_KEY;
  const phoneNumberId = process.env.KAPSO_PHONE_NUMBER_ID;
  if (!apiKey || !phoneNumberId) {
    throw new Error('KAPSO_API_KEY and KAPSO_PHONE_NUMBER_ID must be set');
  }
  return { apiKey, phoneNumberId, baseUrl: process.env.KAPSO_BASE_URL };
}

async function send(body: Record<string, unknown>): Promise<void> {
  const { apiKey, phoneNumberId, baseUrl } = config();
  const url = `${baseUrl ?? DEFAULT_BASE_URL}/v24.0/${phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Kapso send failed (${res.status}): ${detail.slice(0, 300)}`);
  }
}

export async function sendText(to: string, body: string): Promise<void> {
  await send({ to, type: 'text', text: { body } });
}

export async function sendButtons(
  to: string,
  body: string,
  buttons: readonly ReplyButton[],
): Promise<void> {
  const trimmed = buttons.slice(0, 3).map((b) => ({
    type: 'reply' as const,
    reply: { id: b.id, title: b.title.slice(0, 20) },
  }));
  await send({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: { buttons: trimmed },
    },
  });
}

/** Best-effort read receipt; never throws into the caller. */
export async function markRead(messageId: string): Promise<void> {
  try {
    await send({ status: 'read', message_id: messageId });
  } catch {
    // read receipts are non-critical
  }
}
