/**
 * ego-web — the WEB version of ego-lite (citrolabs/ego-lite).
 *
 * ego-lite is a macOS desktop Chromium that exposes `globalThis.ego` so AI agents can
 * drive a browser that already holds your logged-in sessions. It cannot be deployed
 * (macOS .dmg, GUI). This is the same idea as a DEPLOYABLE Linux service:
 *
 *   headless Chromium (persistent profiles)  →  CDP/Playwright  →  agent-facing API
 *                                            →  live web viewer (watch + log in yourself)
 *
 * Parity with ego-lite that actually matters for agents:
 *   • task spaces      — named PERSISTENT profiles, so logins survive across runs
 *   • page.snapshot()  — numbered @eN refs of interactive elements (what lets an LLM
 *                        say "click @e5" instead of guessing CSS selectors)
 *   • Playwright-style facades preloaded into an agent script (page/browser/taskSpaces)
 *   • one-shot script execution (the heredoc equivalent) → POST /v1/run
 *   • a viewer so a human can log into a site once; the agent inherits that session
 *
 * Env:
 *   PORT           (Railway sets this)         EGO_API_KEY  bearer token for /v1/* + viewer
 *   EGO_DATA_DIR   default /data               EGO_HEADLESS default "1"
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.EGO_API_KEY || '';
const DATA_DIR = process.env.EGO_DATA_DIR || '/data';
const HEADLESS = (process.env.EGO_HEADLESS ?? '1') !== '0';
const DEFAULT_SPACE = process.env.EGO_DEFAULT_SPACE || 'default';

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ─────────────────────────── task spaces (persistent profiles) ─────────────────────────
 * A "space" = one Chromium persistent context on disk. Logging in inside a space (via the
 * viewer) leaves cookies/localStorage on the volume, so every later agent run reuses that
 * session. This is ego-lite's "share your logged-in browser state with your AI", server-side.
 */
const spaces = new Map(); // name -> { ctx, page, lastUsed }

function safeName(n) {
  return String(n || DEFAULT_SPACE).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || DEFAULT_SPACE;
}

async function getSpace(name) {
  const key = safeName(name);
  const existing = spaces.get(key);
  if (existing) { existing.lastUsed = Date.now(); return existing; }

  const userDataDir = path.join(DATA_DIR, 'spaces', key);
  fs.mkdirSync(userDataDir, { recursive: true });
  log('space: launching', key, 'headless=', HEADLESS);
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 800 },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const rec = { ctx, page, lastUsed: Date.now(), name: key };
  spaces.set(key, rec);
  ctx.on('close', () => spaces.delete(key));
  return rec;
}

async function activePage(space) {
  const s = await getSpace(space);
  // follow the most recently opened tab so agent + viewer stay in sync
  const pages = s.ctx.pages().filter((p) => !p.isClosed());
  if (pages.length) s.page = pages[pages.length - 1];
  return s.page;
}

/* ───────────────────────────── snapshot: the @eN ref map ─────────────────────────────
 * The single most important agent affordance: a compact, numbered list of what is
 * actually interactive on the page, so the model targets @e7 instead of inventing a
 * selector. Refs are stashed on window.__egoRefs for click/fill to resolve.
 */
const SNAPSHOT_JS = `(() => {
  const out = []; const refs = [];
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) return false;
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight + 1200 && r.left < innerWidth + 400;
  };
  const label = (el) => (
    el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') ||
    el.getAttribute('name') || el.getAttribute('value') ||
    (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ')
  ).slice(0, 120);
  const SEL = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=textbox],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=true],[onclick]';
  document.querySelectorAll(SEL).forEach((el) => {
    if (!vis(el)) return;
    if (el.disabled) return;
    const i = refs.length + 1; refs.push(el);
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const extra = [type ? 'type=' + type : '', el.getAttribute('href') ? 'href=' + el.getAttribute('href').slice(0, 60) : ''].filter(Boolean).join(' ');
    out.push('@e' + i + ' <' + tag + (extra ? ' ' + extra : '') + '> ' + JSON.stringify(label(el)));
  });
  window.__egoRefs = refs;
  const heading = (document.querySelector('h1')?.innerText || '').trim().slice(0, 120);
  return { url: location.href, title: document.title, heading, count: refs.length, elements: out.join('\\n') };
})()`;

async function snapshot(space) {
  const page = await activePage(space);
  const snap = await page.evaluate(SNAPSHOT_JS);
  return snap;
}

async function resolve(page, ref) {
  const m = /^@e(\d+)$/.exec(String(ref).trim());
  if (!m) return page.locator(String(ref)); // plain CSS/text selector still works
  const idx = Number(m[1]) - 1;
  const handle = await page.evaluateHandle((i) => (window.__egoRefs || [])[i], idx);
  const el = handle.asElement();
  if (!el) throw new Error(`ref ${ref} not found — take a fresh snapshot()`);
  return el;
}

/* ─────────────────────────────── agent-facing facades ─────────────────────────────── */
function makeFacades(space, logs) {
  const P = () => activePage(space);
  const page = {
    async goto(url, opts = {}) {
      const p = await P();
      await p.goto(url, { waitUntil: opts.waitUntil || 'domcontentloaded', timeout: opts.timeout || 45000 });
      return { url: p.url(), title: await p.title() };
    },
    async snapshot() { return snapshot(space); },
    async info() { const p = await P(); return { url: p.url(), title: await p.title() }; },
    async click(ref, opts = {}) {
      const p = await P(); const el = await resolve(p, ref);
      await el.click({ timeout: opts.timeout || 15000 });
      await p.waitForLoadState('domcontentloaded').catch(() => {});
      return true;
    },
    async fill(ref, text) {
      const p = await P(); const el = await resolve(p, ref);
      await el.fill(String(text)); return true;
    },
    async type(ref, text, opts = {}) {
      const p = await P(); const el = await resolve(p, ref);
      await el.type(String(text), { delay: opts.delay ?? 25 }); return true;
    },
    async press(key) { const p = await P(); await p.keyboard.press(key); return true; },
    async waitFor(sel, opts = {}) { const p = await P(); await p.waitForSelector(sel, { timeout: opts.timeout || 20000 }); return true; },
    async text(sel) { const p = await P(); return sel ? await p.locator(sel).first().innerText() : await p.locator('body').innerText(); },
    async evaluate(fn, arg) { const p = await P(); return p.evaluate(typeof fn === 'string' ? fn : String(fn), arg); },
    async screenshot(opts = {}) { const p = await P(); return (await p.screenshot({ fullPage: !!opts.fullPage })).toString('base64'); },
    async scroll(dy = 600) { const p = await P(); await p.mouse.wheel(0, dy); return true; },
  };
  const browser = {
    async openOrReuseTab(url, opts = {}) {
      const s = await getSpace(space);
      const hit = s.ctx.pages().find((p) => !p.isClosed() && p.url().startsWith(url.split('?')[0]));
      if (hit) { s.page = hit; await hit.bringToFront(); return { reused: true, url: hit.url() }; }
      const np = await s.ctx.newPage();
      await np.goto(url, { waitUntil: opts.wait === false ? 'commit' : 'domcontentloaded', timeout: 45000 });
      s.page = np; return { reused: false, url: np.url() };
    },
    async tabs() { const s = await getSpace(space); return s.ctx.pages().filter((p) => !p.isClosed()).map((p) => p.url()); },
    async cookies() { const s = await getSpace(space); return s.ctx.cookies(); },
  };
  const taskSpaces = {
    async useOrCreate(name) { await getSpace(name); return { space: safeName(name) }; },
    list() { return fs.existsSync(path.join(DATA_DIR, 'spaces')) ? fs.readdirSync(path.join(DATA_DIR, 'spaces')) : []; },
  };
  const console_ = { log: (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) };
  return { page, browser, taskSpaces, console: console_ };
}

/** Run an agent script with the facades preloaded — the web equivalent of
 *  `ego-browser nodejs <<'EOF' ... EOF`. */
async function runScript(script, space) {
  const logs = [];
  const f = makeFacades(space, logs);
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFn('page', 'browser', 'taskSpaces', 'console', `"use strict";\n${script}`);
  const result = await fn(f.page, f.browser, f.taskSpaces, f.console);
  return { ok: true, result: result ?? null, logs };
}

/* ─────────────────────────────────── http plumbing ─────────────────────────────────── */
const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length, 'access-control-allow-origin': '*' });
  res.end(b);
};
const body = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { ok({}); } }); });
const authed = (req, url) => {
  if (!API_KEY) return true; // open only if no key configured
  const h = req.headers.authorization || '';
  if (h === `Bearer ${API_KEY}`) return true;
  return url.searchParams.get('key') === API_KEY;
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }); return res.end(); }
    if (p === '/healthz') return json(res, 200, { ok: true, spaces: [...spaces.keys()], headless: HEADLESS });

    if (p === '/' || p === '/index.html') {
      if (!authed(req, url)) { res.writeHead(401, { 'content-type': 'text/html' }); return res.end('<h3>401 — add ?key=YOUR_EGO_API_KEY</h3>'); }
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }

    if (p.startsWith('/v1/')) {
      if (!authed(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' });
      const b = req.method === 'POST' ? await body(req) : Object.fromEntries(url.searchParams);
      const space = b.space || url.searchParams.get('space') || DEFAULT_SPACE;

      if (p === '/v1/run') return json(res, 200, await runScript(String(b.script || ''), space));
      if (p === '/v1/goto') { const f = makeFacades(space, []); return json(res, 200, { ok: true, ...(await f.page.goto(String(b.url))) }); }
      if (p === '/v1/snapshot') return json(res, 200, { ok: true, ...(await snapshot(space)) });
      if (p === '/v1/click') { const f = makeFacades(space, []); await f.page.click(b.ref); return json(res, 200, { ok: true }); }
      if (p === '/v1/fill') { const f = makeFacades(space, []); await f.page.fill(b.ref, b.text); return json(res, 200, { ok: true }); }
      if (p === '/v1/screenshot') { const f = makeFacades(space, []); return json(res, 200, { ok: true, png_base64: await f.page.screenshot({ fullPage: !!b.fullPage }) }); }
      if (p === '/v1/spaces') return json(res, 200, { ok: true, spaces: fs.existsSync(path.join(DATA_DIR, 'spaces')) ? fs.readdirSync(path.join(DATA_DIR, 'spaces')) : [] });
      return json(res, 404, { ok: false, error: 'unknown endpoint' });
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    log('ERR', p, e?.message);
    return json(res, 500, { ok: false, error: String(e?.message || e).slice(0, 500) });
  }
});

/* ───────────── live viewer: stream frames + forward real input (log in yourself) ───────────── */
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws' || !authed(req, url)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, url));
});

wss.on('connection', async (ws, req, url) => {
  const space = url.searchParams.get('space') || DEFAULT_SPACE;
  let alive = true;
  ws.on('close', () => (alive = false));
  ws.on('message', async (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      const page = await activePage(space);
      if (m.t === 'click') await page.mouse.click(m.x, m.y);
      else if (m.t === 'move') await page.mouse.move(m.x, m.y);
      else if (m.t === 'wheel') await page.mouse.wheel(0, m.dy);
      else if (m.t === 'key') await page.keyboard.press(m.key);
      else if (m.t === 'text') await page.keyboard.type(m.text, { delay: 15 });
      else if (m.t === 'goto') await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      else if (m.t === 'back') await page.goBack().catch(() => {});
    } catch (e) { log('ws input err', e?.message); }
  });
  // frame pump — screenshots are robust across Chromium versions and survive navigation
  (async () => {
    while (alive && ws.readyState === 1) {
      try {
        const page = await activePage(space);
        const png = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 8000 });
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'frame', b64: png.toString('base64'), url: page.url(), title: await page.title().catch(() => '') }));
      } catch (e) { /* navigating — skip this frame */ }
      await new Promise((r) => setTimeout(r, 350));
    }
  })();
});

server.listen(PORT, '0.0.0.0', () => log(`ego-web listening on :${PORT} (data=${DATA_DIR}, auth=${API_KEY ? 'on' : 'OFF'})`));
