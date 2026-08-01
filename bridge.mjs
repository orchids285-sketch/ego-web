/**
 * bridge.mjs — plugs this browser into the platform's existing brain.
 *
 * The hands are useless without the rest of the body. Everything below already exists in
 * the FoundReach backend; none of it is reimplemented here, it is *called*:
 *
 *   knowledge   /api/kb/articles      company procedures, playbooks, docs
 *   memory      /api/spine/emit       what happened, so the next run is smarter
 *   API-first   /api/actions/nl       "one sentence -> real actions, executed"
 *               /api/actions/catalog  what can be done through a real API today
 *   audit       /api/audit/log        every step traceable: action, reason, result
 *
 * The API-first call is the important one. Driving a UI is the fallback, not the goal:
 * if the platform can already do the job through a real integration, that is faster,
 * cheaper and far more reliable than clicking. Computer use is what makes the agent
 * *universal*; APIs are what make it *good*. This bridge is where that choice is made.
 *
 * Every function degrades to a no-op when FR_API_URL is unset or the backend is down, so
 * ego-web keeps working standalone.
 */
const BASE = (process.env.FR_API_URL || '').replace(/\/$/, '');
const TOKEN = process.env.FR_API_TOKEN || '';
const USER = process.env.FR_USER_ID || '';
const TIMEOUT = Number(process.env.FR_TIMEOUT_MS || 15000);

export function bridged() { return Boolean(BASE); }

async function call(path, { method = 'POST', body } = {}) {
  if (!BASE) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; } finally { clearTimeout(t); }
}

/**
 * What does the company already know that bears on this goal?
 * Procedures, past decisions, house rules — so the agent behaves like someone who works
 * here, not a stranger clicking around.
 */
export async function recall(goal, { userId = USER, limit = 4 } = {}) {
  const r = await call(`/api/kb/articles?q=${encodeURIComponent(String(goal).slice(0, 200))}&limit=${limit}`
                        + (userId ? `&user_id=${encodeURIComponent(userId)}` : ''), { method: 'GET' });
  const rows = r?.articles || r?.items || r?.results || [];
  return rows.map((a) => ({
    title: a.title || a.name || '',
    text: String(a.summary || a.excerpt || a.content || a.body || '').slice(0, 600),
  })).filter((x) => x.text);
}

/**
 * API-first. Ask the platform whether this goal is achievable through a real integration
 * before we start clicking. `dry` only inspects; it never executes.
 */
export async function apiRoute(goal, { userId = USER, execute = false } = {}) {
  if (!BASE || !userId) return null;
  const r = await call('/api/actions/nl', {
    body: { user_id: userId, instruction: String(goal).slice(0, 500), dry_run: !execute },
  });
  if (!r || r.ok === false) return null;
  const steps = r.steps || r.actions || r.plan || [];
  if (!steps.length) return null;
  return { executed: !!execute && r.ok !== false, steps, raw: r };
}

/** Which real integrations are live for this user (used to brief the model honestly). */
export async function apiCatalog({ userId = USER } = {}) {
  const r = await call('/api/actions/catalog' + (userId ? `?user_id=${encodeURIComponent(userId)}` : ''), { method: 'GET' });
  const tools = r?.catalog || r?.tools || r?.actions || [];
  return Array.isArray(tools) ? tools.slice(0, 60).map((t) => t.name || t.id || t.slug || String(t)) : [];
}

/** Audit: action, reason, source, result — the trust layer's raw material. */
export async function audit(event, data = {}) {
  return call('/api/audit/log', {
    body: { source: 'ego-web', event, user_id: USER || undefined, ...data },
  });
}

/** Feed the data spine so a run in the browser is visible to the rest of the platform. */
export async function emit(kind, payload = {}) {
  return call('/api/spine/emit', { body: { source: 'ego-web', kind, user_id: USER || undefined, ...payload } });
}

/** One compact context block for the model: what we know + what we could do via API. */
export async function context(goal) {
  if (!BASE) return '';
  const [know, cat] = await Promise.all([recall(goal), apiCatalog()]);
  const parts = [];
  if (know.length) parts.push('WHAT THIS COMPANY ALREADY KNOWS (follow it):\n' +
    know.map((k) => `- ${k.title}: ${k.text.slice(0, 300)}`).join('\n'));
  if (cat.length) parts.push('REAL INTEGRATIONS AVAILABLE (prefer these over clicking): ' + cat.join(', '));
  return parts.join('\n\n');
}
