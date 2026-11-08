import type { InboundMessage } from '../whatsapp/inbound';
import { sendButtons, sendText, markRead } from '../whatsapp/client';
import { resolveStaff } from '../identity';
import { getSessionStore } from '../session/store';
import { withSenderLock } from '../session/lock';
import type { PendingAction, ThreadState } from '../session/types';
import { runAgentTurn } from './run';
import { executePendingAction, renderPlan } from './execute';

const STORE_ID_DEFAULT = () => {
  const n = Number(process.env.PONTIMPO_STORE_ID);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

const CONFIRM_BUTTON = 'confirm';
const CANCEL_BUTTON = 'cancel';
const CONFIRM_WORDS = /^(s[ií]|dale|ok|oka?y|confirmo|confirmar|listo|de una)\b/i;
const CANCEL_WORDS = /^(no|cancelar|cancel[áa]|nop|negativo)\b/i;

const REFUSAL =
  'Hola, no puedo atender este número. Si sos del personal de la gomería, pedile al encargado que te dé de alta.';

const CONFIRM_BUTTONS = [
  { id: CONFIRM_BUTTON, title: 'Confirmar' },
  { id: CANCEL_BUTTON, title: 'Cancelar' },
] as const;

type Decision = 'confirm' | 'cancel' | 'other';

function decideFromInbound(inbound: InboundMessage): Decision {
  if (inbound.kind === 'button') {
    if (inbound.buttonId === CONFIRM_BUTTON) return 'confirm';
    if (inbound.buttonId === CANCEL_BUTTON) return 'cancel';
    return 'other';
  }
  const t = inbound.text.trim();
  if (CONFIRM_WORDS.test(t)) return 'confirm';
  if (CANCEL_WORDS.test(t)) return 'cancel';
  return 'other';
}

/** Reduce an inbound message to the user text to feed the agent. */
function userTextOf(inbound: InboundMessage): string {
  return inbound.kind === 'text' ? inbound.text : inbound.buttonTitle || inbound.buttonId;
}

/**
 * Full async pipeline for one inbound message: identity → lock → load thread →
 * (confirm pending | cancel pending | run agent) → persist → reply. Nothing is
 * mutated until the staff confirms a pending plan.
 */
export async function processInbound(inbound: InboundMessage): Promise<void> {
  const identity = resolveStaff(inbound.from);
  if (!identity) {
    console.warn('[process] refused unknown number:', inbound.from);
    await sendText(inbound.from, REFUSAL);
    return;
  }

  await markRead(inbound.messageId);

  const store = getSessionStore();
  const result = await withSenderLock(store, inbound.from, async (): Promise<Reply> => {
    const thread = await store.getThread(inbound.from);
    const decision = decideFromInbound(inbound);

    if (thread.pending) {
      if (decision === 'confirm') return handleConfirm(inbound, thread);
      if (decision === 'cancel') return handleCancel(inbound, thread);
      // a new substantive message supersedes the stale plan
      await store.clearPending(inbound.from);
      return handleAgent(inbound, identity, { ...thread, pending: null }, 'Descarté la confirmación anterior. ');
    }

    if (decision === 'confirm' || decision === 'cancel') {
      return { text: 'No hay nada pendiente para confirmar.' };
    }
    return handleAgent(inbound, identity, thread, '');
  });

  if (!result.ran) {
    await sendText(inbound.from, 'Estoy con otro mensaje tuyo, dame un segundo y reintentá.');
    return;
  }

  const reply = result.value;
  if (reply.buttons) {
    await sendButtons(inbound.from, reply.text, [...CONFIRM_BUTTONS]);
  } else {
    await sendText(inbound.from, reply.text);
  }
}

interface Reply {
  readonly text: string;
  readonly buttons?: boolean;
}

/**
 * Close a pending plan and record how it ended in the model's history, so the
 * next turn knows nothing is staged any more (and, after a failure, that it
 * must re-read and re-plan instead of pointing at the old plan).
 */
async function closePending(inbound: InboundMessage, thread: ThreadState, outcome: string): Promise<Reply> {
  await getSessionStore().setThread(inbound.from, {
    history: [
      ...thread.history,
      { role: 'user', content: userTextOf(inbound) },
      { role: 'assistant', content: `${outcome}\n\n(El plan anterior quedó cerrado: no hay nada pendiente de confirmar.)` },
    ],
    pending: null,
  });
  return { text: outcome };
}

async function handleConfirm(inbound: InboundMessage, thread: ThreadState): Promise<Reply> {
  const outcome = await executePendingAction(thread.pending as PendingAction);
  return closePending(inbound, thread, outcome.message);
}

async function handleCancel(inbound: InboundMessage, thread: ThreadState): Promise<Reply> {
  return closePending(inbound, thread, 'Listo, cancelado. No toqué nada.');
}

async function handleAgent(
  inbound: InboundMessage,
  identity: { staffName: string; onBehalfOf: string },
  thread: ThreadState,
  prefix: string,
): Promise<Reply> {
  const store = getSessionStore();
  const turn = await runAgentTurn({
    staffName: identity.staffName,
    onBehalfOf: identity.onBehalfOf,
    storeId: STORE_ID_DEFAULT(),
    history: thread.history,
    userText: userTextOf(inbound),
  });

  if (turn.steps.length > 0) {
    // a correction was planned → persist as pending, ask to confirm
    const pending: PendingAction = {
      corrId: turn.corrId,
      steps: turn.steps,
      createdAt: Date.now(),
    };
    await store.setThread(inbound.from, { history: turn.messages, pending });
    return { text: prefix + renderPlan(pending), buttons: true };
  }

  // analytics / plain answer
  await store.setThread(inbound.from, { history: turn.messages, pending: null });
  return { text: prefix + turn.text };
}
