/**
 * Parse a Kapso `whatsapp.message.received` webhook payload into a normalized
 * inbound message. Shapes verified against Kapso's webhook event-types docs:
 *
 *   { message: { id, from, type, text: { body }, interactive: {...} },
 *     conversation: { phone_number_id, ... },
 *     is_new_conversation: bool, phone_number_id }
 *
 * A button tap arrives as `type: 'interactive'` with
 * `interactive.button_reply.{id,title}`.
 */

export interface InboundText {
  readonly kind: 'text';
  readonly from: string;
  readonly messageId: string;
  readonly phoneNumberId: string | null;
  readonly isNewConversation: boolean;
  readonly text: string;
}

export interface InboundButton {
  readonly kind: 'button';
  readonly from: string;
  readonly messageId: string;
  readonly phoneNumberId: string | null;
  readonly isNewConversation: boolean;
  readonly buttonId: string;
  readonly buttonTitle: string;
}

export type InboundMessage = InboundText | InboundButton;

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * Returns the normalized message, or `null` if this payload is not an inbound
 * text/button we handle (the caller acks 200 and ignores).
 */
export function parseInbound(payload: unknown): InboundMessage | null {
  const root = asRecord(payload);
  if (!root) return null;

  const message = asRecord(root.message);
  if (!message) return null;

  const from = asString(message.from);
  const messageId = asString(message.id);
  if (!from || !messageId) return null;

  const phoneNumberId =
    asString(root.phone_number_id) ??
    asString(asRecord(root.conversation)?.phone_number_id);
  const isNewConversation = root.is_new_conversation === true;

  const base = { from, messageId, phoneNumberId, isNewConversation } as const;

  const type = asString(message.type);

  if (type === 'text') {
    const text = asString(asRecord(message.text)?.body);
    if (!text) return null;
    return { kind: 'text', ...base, text };
  }

  if (type === 'interactive') {
    const interactive = asRecord(message.interactive);
    const buttonReply = asRecord(interactive?.button_reply);
    const buttonId = asString(buttonReply?.id);
    const buttonTitle = asString(buttonReply?.title);
    if (!buttonId) return null;
    return {
      kind: 'button',
      ...base,
      buttonId,
      buttonTitle: buttonTitle ?? '',
    };
  }

  return null;
}
