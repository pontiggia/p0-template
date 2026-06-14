/**
 * Phase 9.1 behavioural check (pure logic, no server):
 *   - signature verify: valid passes, tampered body fails, bad sig fails
 *   - inbound parsing: text + button reply + ignore non-handled
 * Run: pnpm exec tsx scripts/verify-91.mts
 */
import { createHmac } from 'node:crypto';
import { verifyKapsoSignature } from '../src/lib/whatsapp/verify.ts';
import { parseInbound } from '../src/lib/whatsapp/inbound.ts';

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const secret = 'test-secret-123';
const textPayload = JSON.stringify({
  message: { id: 'wamid.AAA', from: '5492916123456', type: 'text', text: { body: 'hola' } },
  conversation: { phone_number_id: '111222333' },
  is_new_conversation: true,
  phone_number_id: '111222333',
});
const goodSig = createHmac('sha256', secret).update(textPayload, 'utf8').digest('hex');

check('valid signature passes', verifyKapsoSignature(textPayload, goodSig, secret) === true);
check('tampered body fails', verifyKapsoSignature(textPayload + ' ', goodSig, secret) === false);
check('wrong signature fails', verifyKapsoSignature(textPayload, 'deadbeef', secret) === false);
check('null signature fails', verifyKapsoSignature(textPayload, null, secret) === false);
check('empty secret fails', verifyKapsoSignature(textPayload, goodSig, '') === false);

const text = parseInbound(JSON.parse(textPayload));
check('parses text from', text?.kind === 'text' && text.from === '5492916123456');
check('parses text body', text?.kind === 'text' && text.text === 'hola');
check('parses messageId', text?.messageId === 'wamid.AAA');
check('parses phoneNumberId', text?.phoneNumberId === '111222333');
check('parses is_new_conversation', text?.isNewConversation === true);

const button = parseInbound({
  message: {
    id: 'wamid.BBB',
    from: '5492916123456',
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: 'confirm', title: 'Confirmar' } },
  },
  phone_number_id: '111222333',
});
check('parses button id', button?.kind === 'button' && button.buttonId === 'confirm');
check('parses button title', button?.kind === 'button' && button.buttonTitle === 'Confirmar');

check('ignores delivery receipt', parseInbound({ message: { id: 'x', from: 'y', type: 'reaction' } }) === null);
check('ignores empty', parseInbound({}) === null);
check('ignores text without body', parseInbound({ message: { id: 'x', from: 'y', type: 'text', text: {} } }) === null);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
