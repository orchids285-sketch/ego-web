/**
 * ticket.mjs — verify the SaaS's short-lived embed ticket.
 *
 * The panel runs in an iframe, so anything that authorises it is visible to the person
 * looking at the page. Passing EGO_API_KEY in the URL would therefore hand every user the
 * same shared credential — one screenshot of the address bar and it is everyone's.
 *
 * So the SaaS mints a ticket instead, from its gated /api/embed-ticket, signed for the
 * caller's OWN id. This is the same HMAC the backend's lib/embed_ticket.py uses, so the
 * two agree without either side learning about the other: sha256(secret, "uid:bucket"),
 * five-minute buckets, current or previous accepted so a clock skew or a slow load does
 * not lock someone out.
 *
 * The secret is shared config (EMBED_TICKET_SECRET), never traffic.
 */
import crypto from 'node:crypto';

const secret = () =>
  process.env.EMBED_TICKET_SECRET || process.env.SECRET_KEY ||
  process.env.API_KEY_SECRET || 'fr-embed-ticket-fallback';

const sig = (uid, bucket) =>
  crypto.createHmac('sha256', secret()).update(`${uid}:${bucket}`).digest('hex').slice(0, 40);

/** Is `ticket` a valid signature for `uid` right now? Constant-time compare. */
export function verifyTicket(uid, ticket) {
  if (!uid || !ticket) return false;
  const now = Math.floor(Date.now() / 1000 / 300);
  const given = Buffer.from(String(ticket));
  for (const bucket of [now, now - 1]) {
    const want = Buffer.from(sig(uid, bucket));
    if (want.length === given.length && crypto.timingSafeEqual(want, given)) return true;
  }
  return false;
}

/** Mint one — used by the tests, and handy for a curl against a local instance. */
export function mintTicket(uid) {
  return sig(uid, Math.floor(Date.now() / 1000 / 300));
}
