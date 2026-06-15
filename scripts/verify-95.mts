/** Phase 9.5: identity allowlist resolution edge cases. */
import { resolveStaff, resetIdentityCache } from '../src/lib/identity.ts';
let failures = 0;
const check = (n: string, c: boolean) => { console.log(`${c?'PASS':'FAIL'}  ${n}`); if(!c) failures++; };

process.env.STAFF_ALLOWLIST = JSON.stringify({ '5492916123456': { staffName:'Oscar', onBehalfOf:'oscar@x.com' } });
resetIdentityCache();
check('exact match resolves', resolveStaff('5492916123456')?.staffName === 'Oscar');
check('formatted "+54 9 291 612-3456" matches (normalized)', resolveStaff('+54 9 291 612-3456')?.onBehalfOf === 'oscar@x.com');
check('unknown number → null', resolveStaff('5490000000000') === null);

process.env.STAFF_ALLOWLIST = '{not json';
resetIdentityCache();
check('malformed JSON → empty (null), no throw', resolveStaff('5492916123456') === null);

process.env.STAFF_ALLOWLIST = JSON.stringify({ '549': { staffName:'X' } }); // missing onBehalfOf
resetIdentityCache();
check('incomplete identity skipped', resolveStaff('549') === null);

delete process.env.STAFF_ALLOWLIST;
resetIdentityCache();
check('no allowlist → null', resolveStaff('549') === null);

console.log(failures===0?'\nALL PASS':`\n${failures} FAILED`);
process.exit(failures===0?0:1);
