import { apiPost, PontimpoApiError } from '../pontimpo/client';
import type { PendingAction, PlannedStep } from '../session/types';

/**
 * Render the confirmation message from the STRUCTURED steps (not the model's
 * prose), so what the staff sees is exactly what will execute. Amounts in the
 * step summaries were already formatted es-AR by the tools.
 */
export function renderPlan(action: PendingAction): string {
  const lines = action.steps.map((s, i) => `${i + 1}) ${s.summary}`);
  return [
    'Voy a hacer esto:',
    ...lines,
    '',
    '¿Confirmás?',
  ].join('\n');
}

export interface ExecuteOutcome {
  /** es-AR message reporting what happened */
  readonly message: string;
  /** true if every step applied (or was replayed) successfully */
  readonly ok: boolean;
  /** how many steps were applied before stopping */
  readonly appliedCount: number;
}

/**
 * Execute a confirmed plan: POST each step in order, reusing its pre-minted
 * idempotency key. Stop on the first error, reporting which steps already
 * applied + the server's Spanish message. The caller discards the pending
 * action either way (success → done; error → forces a fresh re-plan).
 *
 * `poster` is injectable for testing; defaults to the real client.
 */
export async function executePendingAction(
  action: PendingAction,
  poster: typeof apiPost = apiPost,
): Promise<ExecuteOutcome> {
  const applied: string[] = [];

  for (const step of action.steps) {
    try {
      const { replayed } = await poster(step.path, step.body, step.idempotencyKey);
      applied.push(replayed ? `${step.summary} (ya estaba hecho)` : step.summary);
    } catch (err) {
      const detail = PontimpoApiError.is(err)
        ? err.userMessage
        : 'Algo salió mal, intenta de nuevo';
      return {
        ok: false,
        appliedCount: applied.length,
        message: buildErrorReport(applied, step, detail),
      };
    }
  }

  return {
    ok: true,
    appliedCount: applied.length,
    message: ['Listo. Hice:', ...applied.map((a, i) => `${i + 1}) ${a}`)].join('\n'),
  };
}

function buildErrorReport(applied: string[], failedStep: PlannedStep, detail: string): string {
  const head =
    applied.length === 0
      ? 'No pude aplicar la corrección.'
      : ['Apliqué parte y me frené:', ...applied.map((a, i) => `${i + 1}) ${a}`)].join('\n');
  return [
    head,
    '',
    `Se frenó en: ${failedStep.summary}`,
    `Motivo: ${detail}`,
    '',
    'Pedímelo de nuevo así lo reviso con los datos actuales.',
  ].join('\n');
}
