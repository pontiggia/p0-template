// §13 "Webhook hardening: bad signature → 401; slow path still returns 200
// within budget and replies asynchronously" + "redeliver the same webhook →
// no double application". Drives the real route handler.
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { startKapsoStub, type KapsoStub } from './helpers/kapso-stub';

const h = vi.hoisted(() => ({
  background: [] as Promise<unknown>[],
  processInbound: vi.fn(),
}));

// Outside Vercel there is no request context; capture waitUntil's promise so
// the test can await the async half explicitly.
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => void h.background.push(p) }));
vi.mock('@/lib/agent/process', () => ({ processInbound: h.processInbound }));

const { POST } = await import('@/app/api/webhooks/kapso/route');
const { sendText } = await import('@/lib/whatsapp/client');

const SECRET = process.env.KAPSO_WEBHOOK_SECRET!;
const sign = (raw: string, secret = SECRET) => createHmac('sha256', secret).update(raw, 'utf8').digest('hex');

let seq = 0;
function inbound(text = 'hola') {
  return JSON.stringify({
    message: { id: `wamid.${++seq}`, from: '5490000000001', type: 'text', text: { body: text } },
    phone_number_id: 'stub-phone-number-id',
  });
}

function deliver(raw: string, headers: Record<string, string>) {
  return POST(
    new Request('http://localhost/api/webhooks/kapso', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw,
    }) as never,
  );
}

let kapso: KapsoStub;
beforeAll(async () => {
  kapso = await startKapsoStub();
});
afterAll(() => kapso.close());
beforeEach(() => {
  h.background.length = 0;
  h.processInbound.mockReset();
  kapso.reset();
});

describe('signature', () => {
  it('missing signature → 401, nothing processed', async () => {
    const res = await deliver(inbound(), {});
    expect(res.status).toBe(401);
    expect(h.processInbound).not.toHaveBeenCalled();
  });

  it('signed with the wrong secret → 401', async () => {
    const raw = inbound();
    const res = await deliver(raw, { 'x-webhook-signature': sign(raw, 'not-the-secret') });
    expect(res.status).toBe(401);
    expect(h.processInbound).not.toHaveBeenCalled();
  });

  it('body tampered after signing → 401 (verified over the raw bytes)', async () => {
    const raw = inbound('pagá 100');
    const res = await deliver(raw.replace('100', '900'), { 'x-webhook-signature': sign(raw) });
    expect(res.status).toBe(401);
  });

  it('garbage signature (non-hex / wrong length) → 401, no throw', async () => {
    const raw = inbound();
    expect((await deliver(raw, { 'x-webhook-signature': 'zz' })).status).toBe(401);
    expect((await deliver(raw, { 'x-webhook-signature': sign(raw).slice(0, 10) })).status).toBe(401);
  });
});

describe('fast ack, async reply', () => {
  it('valid signature → 200 immediately while a 3 s agent run replies later via the send API', async () => {
    h.processInbound.mockImplementation(async (msg: { from: string }) => {
      await new Promise((r) => setTimeout(r, 3_000));
      await sendText(msg.from, 'respuesta tardía');
    });
    const raw = inbound();

    const started = performance.now();
    const res = await deliver(raw, { 'x-webhook-signature': sign(raw), 'x-idempotency-key': `d-${seq}` });
    const ackMs = performance.now() - started;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ackMs).toBeLessThan(500); // budget is 10 s; the ack must not wait on the agent
    expect(kapso.replies()).toHaveLength(0); // nothing rides on the HTTP response

    await Promise.all(h.background);
    expect(kapso.replies()).toHaveLength(1);
    expect(kapso.lastReply().text).toBe('respuesta tardía');
    expect(kapso.sent[0].apiKey).toBe('stub-kapso-key');
  });
});

describe('redelivery dedupe (X-Idempotency-Key)', () => {
  it('the same delivery twice is processed once — while in flight and after done', async () => {
    let release!: () => void;
    h.processInbound.mockImplementation(() => new Promise<void>((r) => (release = r)));
    const raw = inbound();
    const headers = { 'x-webhook-signature': sign(raw), 'x-idempotency-key': `dup-${seq}` };

    expect(await (await deliver(raw, headers)).json()).toEqual({ ok: true });
    // Kapso retries while the first run is still going…
    expect(await (await deliver(raw, headers)).json()).toEqual({ duplicate: true });
    release();
    await Promise.all(h.background);
    // …and again after it finished.
    expect(await (await deliver(raw, headers)).json()).toEqual({ duplicate: true });

    expect(h.processInbound).toHaveBeenCalledTimes(1);
  });

  it('without the header, dedupes on sender + message id', async () => {
    h.processInbound.mockResolvedValue(undefined);
    const raw = inbound();
    await deliver(raw, { 'x-webhook-signature': sign(raw) });
    await Promise.all(h.background);
    expect(await (await deliver(raw, { 'x-webhook-signature': sign(raw) })).json()).toEqual({ duplicate: true });
    expect(h.processInbound).toHaveBeenCalledTimes(1);
  });

  it('different deliveries are both processed', async () => {
    h.processInbound.mockResolvedValue(undefined);
    for (const text of ['a', 'b']) {
      const raw = inbound(text);
      await deliver(raw, { 'x-webhook-signature': sign(raw), 'x-idempotency-key': `k-${seq}` });
    }
    await Promise.all(h.background);
    expect(h.processInbound).toHaveBeenCalledTimes(2);
  });
});
