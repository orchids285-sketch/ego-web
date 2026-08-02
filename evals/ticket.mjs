/**
 * The panel is authorised by a ticket the SaaS mints, not by the shared API key.
 *
 * Two implementations have to agree — lib/embed_ticket.py signs it, ticket.mjs verifies
 * it — and they never talk, so the only thing keeping them together is that both compute
 * sha256(secret, "uid:bucket") over the same five-minute bucket. A drift here does not
 * throw; it just stops authorising anyone, which is why it is pinned.
 *
 *   node evals/ticket.mjs
 */
process.env.EMBED_TICKET_SECRET = process.env.EMBED_TICKET_SECRET || 'test-shared-secret-123';
const { verifyTicket, mintTicket } = await import('../ticket.mjs');

let pass = 0, total = 0;
const check = (name, cond) => {
  total++;
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else console.log(`  FAIL  ${name}`);
};

console.log('embed ticket\n');

const t = mintTicket('user_alice');
check('a freshly minted ticket is accepted', verifyTicket('user_alice', t));
check('it is refused for a different user', !verifyTicket('user_bob', t));
check('a junk ticket is refused', !verifyTicket('user_alice', 'deadbeef'));
check('an empty ticket is refused', !verifyTicket('user_alice', ''));
check('an empty user is refused', !verifyTicket('', t));
check('a ticket of the wrong length is refused', !verifyTicket('user_alice', t + 'aa'));

// The previous bucket must still work: a page that loads slowly, or a clock a few seconds
// off, would otherwise lock the user out for no reason.
const secret = process.env.EMBED_TICKET_SECRET;
const crypto = await import('node:crypto');
const sig = (uid, b) => crypto.createHmac('sha256', secret).update(`${uid}:${b}`).digest('hex').slice(0, 40);
const prev = sig('user_alice', Math.floor(Date.now() / 1000 / 300) - 1);
check('the previous 5-minute bucket is still accepted', verifyTicket('user_alice', prev));

const old = sig('user_alice', Math.floor(Date.now() / 1000 / 300) - 3);
check('an expired bucket is refused', !verifyTicket('user_alice', old));

console.log(`\n${pass}/${total}`);
process.exitCode = pass === total ? 0 : 1;
