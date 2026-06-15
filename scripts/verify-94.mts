/**
 * Phase 9.4 behavioural check (offline, mocked Pontimpo client):
 * plan rendering, execute order, idempotency replay, mid-execute error stop,
 * pending TTL pruning, per-sender lock serialization.
 * Run: pnpm exec tsx scripts/verify-94.mts
 */
import { renderPlan, executePendingAction } from '../src/lib/agent/execute.ts';
import { PontimpoApiError } from '../src/lib/pontimpo/client.ts';
import { withSenderLock } from '../src/lib/session/lock.ts';
import { getSessionStore, PENDING_TTL_MS } from '../src/lib/session/store.ts';
import type { PendingAction, PlannedStep } from '../src/lib/session/types.ts';

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got: ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}

function step(call: string, path: string, summary: string): PlannedStep {
  return { call, path, body: { x: 1 }, idempotencyKey: `key-${path}`, summary };
}

// R11 + 4×R2 plan (the worked scenario)
const action: PendingAction = {
  corrId: 'abc123',
  createdAt: Date.now(),
  steps: [
    step('reversePayment', '/ledger-entries/9/reverse', 'Revertir el pago (id 9).'),
    step('registerSalePayment', '/sales/4123/payments#1', 'Registrar pago de $20.000,00 (cheque).'),
    step('registerSalePayment', '/sales/4123/payments#2', 'Registrar pago de $20.000,00 (cheque).'),
    step('registerSalePayment', '/sales/4123/payments#3', 'Registrar pago de $20.000,00 (cheque).'),
    step('registerSalePayment', '/sales/4123/payments#4', 'Registrar pago de $20.000,00 (cheque).'),
  ],
};

// 1) renderPlan from structured steps
const plan = renderPlan(action);
check('plan numbers all 5 steps', /1\)/.test(plan) && /5\)/.test(plan));
check('plan shows reversal first', plan.indexOf('Revertir') < plan.indexOf('Registrar pago'));
check('plan asks to confirm', plan.includes('¿Confirmás?'));

// 2) happy path: all steps POST in order, no replay
const calls: string[] = [];
const okPoster = async (path: string) => {
  calls.push(path);
  return { data: {}, replayed: false };
};
const r1 = await executePendingAction(action, okPoster as never);
check('happy: ok', r1.ok === true);
check('happy: 5 applied', r1.appliedCount === 5, r1.appliedCount);
check('happy: order preserved', calls[0] === '/ledger-entries/9/reverse' && calls[4] === '/sales/4123/payments#4');
check('happy: reports Listo', r1.message.startsWith('Listo.'));

// 3) idempotency replay: poster reports replayed → "ya estaba hecho", still ok
const replayPoster = async () => ({ data: {}, replayed: true });
const r2 = await executePendingAction(action, replayPoster as never);
check('replay: ok', r2.ok === true);
check('replay: notes ya estaba hecho', r2.message.includes('ya estaba hecho'));

// 4) mid-execute error on step 2 → stop, report applied step 1 + Spanish msg
let n = 0;
const failPoster = async () => {
  n++;
  if (n === 2) throw new PontimpoApiError('CONFLICT', 'El registro fue modificado por otra persona, recarga e intenta de nuevo', 409);
  return { data: {}, replayed: false };
};
const r3 = await executePendingAction(action, failPoster as never);
check('error: not ok', r3.ok === false);
check('error: applied 1 before stop', r3.appliedCount === 1, r3.appliedCount);
check('error: surfaces Spanish message', r3.message.includes('modificado por otra persona'));
check('error: tells user to re-ask', r3.message.includes('Pedímelo de nuevo'));

// 5) pending TTL pruning (in-memory store fallback)
const store = getSessionStore();
const stale: PendingAction = { ...action, createdAt: Date.now() - PENDING_TTL_MS - 1000 };
await store.setThread('549111', { history: [], pending: stale });
const loaded = await store.getThread('549111');
check('TTL: stale pending pruned on read', loaded.pending === null);

const fresh: PendingAction = { ...action, createdAt: Date.now() };
await store.setThread('549222', { history: [], pending: fresh });
check('TTL: fresh pending survives', (await store.getThread('549222')).pending !== null);

// 6) per-sender lock serializes
let concurrent = 0;
let maxConcurrent = 0;
const work = async () => {
  concurrent++;
  maxConcurrent = Math.max(maxConcurrent, concurrent);
  await new Promise((r) => setTimeout(r, 50));
  concurrent--;
  return 'done';
};
const [a, b] = await Promise.all([
  withSenderLock(store, '549333', work, { attempts: 10, delayMs: 20 }),
  withSenderLock(store, '549333', work, { attempts: 10, delayMs: 20 }),
]);
check('lock: both eventually ran', a.ran === true && b.ran === true);
check('lock: never ran concurrently', maxConcurrent === 1, maxConcurrent);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
