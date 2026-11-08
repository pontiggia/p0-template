import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request the agent made to the (stubbed) Kapso send API. */
export interface KapsoSent {
  readonly path: string;
  readonly apiKey: string | undefined;
  readonly body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * Local stand-in for `POST {KAPSO_BASE_URL}/v24.0/{phoneNumberId}/messages`.
 * Points KAPSO_BASE_URL at itself, so nothing can reach Kapso.
 */
export async function startKapsoStub() {
  const sent: KapsoSent[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      sent.push({ path: req.url ?? '', apiKey: req.headers['x-api-key'] as string | undefined, body: JSON.parse(raw || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"messages":[{"id":"wamid.stub"}]}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  process.env.KAPSO_BASE_URL = `http://127.0.0.1:${port}`;

  /** Messages actually shown to a user (text or buttons), read receipts excluded. */
  const replies = () => sent.filter((s) => s.body.type === 'text' || s.body.type === 'interactive');
  const replyText = (s: KapsoSent): string =>
    s.body.type === 'text' ? s.body.text.body : s.body.interactive.body.text;

  return {
    sent,
    replies,
    replyText,
    lastReply: () => {
      const r = replies().at(-1);
      if (!r) throw new Error('no reply was sent');
      return { text: replyText(r), buttons: r.body.type === 'interactive', raw: r };
    },
    reset: () => void sent.splice(0),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export type KapsoStub = Awaited<ReturnType<typeof startKapsoStub>>;
