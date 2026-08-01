# ego-web — the web version of [ego-lite](https://github.com/citrolabs/ego-lite)

**ego-lite** is a macOS desktop Chromium (`.dmg`) that exposes `globalThis.ego` so an AI agent
can drive a browser that already holds **your logged-in sessions**. Because it is a macOS GUI
app, it cannot be deployed to Render/Railway/any Linux host — not a RAM problem, a platform one.

**ego-web is the same idea, built to deploy:**

```
headless Chromium (persistent profiles) → Playwright/CDP → agent HTTP API
                                        → live web viewer (watch it / log in yourself)
```

## What it keeps from ego-lite (the parts that matter to an agent)

| ego-lite | ego-web |
|---|---|
| `taskSpaces.useOrCreate('demo')` | **task spaces** = named persistent Chromium profiles on a volume → logins survive |
| `page.snapshot()` with `@eN` refs | same — a numbered list of interactive elements so the model says `click @e5` |
| `ego-browser nodejs <<'EOF' … EOF` | `POST /v1/run` with a script; `page` / `browser` / `taskSpaces` preloaded |
| shares *your* logged-in browser | open the **viewer**, log into a site once — every later agent run reuses that session |
| macOS only, not deployable | **Dockerfile, Linux, Railway/Fly/any container host** |

## Run

```bash
docker build -t ego-web .
docker run -p 8080:8080 -e EGO_API_KEY=secret -v ego-data:/data ego-web
open "http://localhost:8080/?key=secret"        # the viewer
```

## Agent API (bearer `EGO_API_KEY`)

```bash
# navigate
curl -X POST $HOST/v1/goto -H "Authorization: Bearer $KEY" \
     -H 'Content-Type: application/json' -d '{"url":"https://example.com","space":"demo"}'

# snapshot → the @eN ref map an LLM can target
curl -X POST $HOST/v1/snapshot -H "Authorization: Bearer $KEY" \
     -H 'Content-Type: application/json' -d '{"space":"demo"}'
# → { "url":…, "title":…, "count": 12, "elements": "@e1 <a href=/pricing> \"Pricing\"\n@e2 <button> \"Sign in\"…" }

# act on a ref
curl -X POST $HOST/v1/click -H "Authorization: Bearer $KEY" \
     -H 'Content-Type: application/json' -d '{"ref":"@e2","space":"demo"}'
```

Full script (the heredoc equivalent) — `POST /v1/run`:

```js
await page.goto("https://news.ycombinator.com");
const s = await page.snapshot();
console.log(s.title, s.count);
await page.click("@e3");
return await page.info();
```

Endpoints: `/v1/run` · `/v1/goto` · `/v1/snapshot` · `/v1/click` · `/v1/fill` ·
`/v1/screenshot` · `/v1/spaces` · `/healthz` · `/` (viewer) · `/ws` (viewer stream).

Facades inside `/v1/run`: `page.{goto,snapshot,info,click,fill,type,press,waitFor,text,evaluate,screenshot,scroll}`,
`browser.{openOrReuseTab,tabs,cookies}`, `taskSpaces.{useOrCreate,list}`, `console.log`.

## The session trick (why this beats a plain headless browser)

Bot walls (LinkedIn, X, dashboards) block fresh headless sessions. Here you open the **viewer**,
log in **as a human**, and the cookies land in that space's profile on the volume. Every later
agent run in that space is already authenticated — ego-lite's core idea, server-side.


## Embedded-tool mode (no branding, no auth screen)

Same contract as the other embedded tools in the suite — drop it in an iframe and it renders
as a plain browser: no product name, no login screen, full-bleed.

```tsx
<EmbedFrame src={`${EGO_URL}/?embed=${reloadKey}&fr_user=${encodeURIComponent(userId)}&key=${EGO_KEY}`}
            title="Browser" tool="browser" reloadKey={reloadKey} />
```

* `?embed=` — hides all chrome the host didn't ask for (profile picker, footer, borders) and
  serves `frame-ancestors` instead of `X-Frame-Options`, so framing works.
* `?fr_user=` — each account gets its **own task space** (`u_<id>`), i.e. its own cookies and
  logged-in sessions. Users never see each other's sessions.
* **Auth is invisible**: the host puts `key=` in the iframe URL. If the deployment sits behind a
  white-label proxy that already authenticates, set `EGO_EMBED_OPEN=1` and the `key` can be
  dropped entirely. A non-embedded request without a key still returns 401.
* When unauthorised inside an embed it returns **204 (blank)** instead of an error page, so the
  host shows its own warming/error state.

| var | meaning |
|---|---|
| `EGO_EMBED_OPEN` | `1` = `?embed=` needs no key (use behind an authenticating proxy) |
| `EGO_FRAME_ANCESTORS` | CSP frame-ancestors allowlist (default: self + `*.vercel.app` + `*.up.railway.app`) |

## Deploy on Railway

Dockerfile-based, binds `PORT`. Set `EGO_API_KEY` (always — the viewer drives a real browser),
mount a **volume on `/data`** so task spaces persist, and give it ~2 GB RAM (a Chromium needs far
more than the 512 MB of a free tier).

## Env

| var | default | meaning |
|---|---|---|
| `PORT` | 8080 | HTTP port |
| `EGO_API_KEY` | *(empty = open)* | bearer token for `/v1/*` and the viewer |
| `EGO_DATA_DIR` | `/data` | where task-space profiles live |
| `EGO_HEADLESS` | `1` | `0` runs headful (needs an X server) |
| `EGO_DEFAULT_SPACE` | `default` | space used when none is given |

MIT — same spirit as ego-lite, which this is a web re-implementation of (no ego-lite code copied).
