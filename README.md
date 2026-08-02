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



## It works *inside* the software you already pay for

This is the part that matters. ego-web does not "read your tabs" — it recognises the app on
screen and does the work in it. Your other SaaS stops being a place you have to go and operate
by hand; it becomes a surface an agent operates for you.

```bash
# What can it do on the page I'm looking at?
curl -X POST $HOST/v1/assist -H "Authorization: Bearer $KEY" -d '{"space":"crm"}'
# -> {"app":"HubSpot","knows_app":true,
#     "tasks":[{"id":"create_contact"},{"id":"bulk_import"},{"id":"log_activity"},
#              {"id":"find_duplicates"},{"id":"update_deal_stage"},{"id":"export_view"}],
#     "notes":["Left rail is the object switcher (Contacts, Companies, Deals, Tickets).", ...]}

# Give it a goal, in plain language, on the live page
curl -X POST $HOST/v1/agent -H "Authorization: Bearer $KEY"      -d '{"space":"crm","goal":"Add Jane Doe (jane@acme.com, Acme) as a contact"}'

# Or run a known task from that app's playbook
curl -X POST $HOST/v1/task -H "Authorization: Bearer $KEY"      -d '{"space":"crm","task":"find_duplicates"}'
```

**Playbooks, not selectors.** `playbooks.mjs` holds procedural knowledge per app — how HubSpot is
laid out, that creating a record happens in a right-hand drawer, that LinkedIn punishes fast
loops. The agent grounds each step on a fresh `@eN` snapshot, so a vendor redesign doesn't break
it the way hard-coded selectors always do. Shipping with **13 apps / 34 tasks**: HubSpot, Salesforce, Attio, Pipedrive, Notion, Gmail,
Intercom, Slack, Airtable, Linear, Google Sheets, Stripe, LinkedIn — plus a generic fallback so it
is never useless on an unknown one.

**The loop** (`agent.mjs`): observe → decide → act → verify, max-steps bounded, with a trace of
every step returned to the caller. It refuses irreversible actions (send / pay / refund / delete /
merge / publish / invite) unless the goal explicitly authorises them, and it stops and *asks* at a
login wall instead of guessing credentials — verified live against HubSpot's real login page.

**Your open tabs are the workspace.** `/v1/tabs` lists what is open (with the app recognised per
tab), `/v1/tab` puts the agent on one of them. The viewer shows the same strip, so a human and the
agent are always looking at the same thing.

| endpoint | does |
|---|---|
| `/v1/assist` | which app is on screen + what it can take off your hands |
| `/v1/agent` | plain-language goal, executed step by step on the live page |
| `/v1/task` | one named task from that app's playbook |
| `/v1/tabs` · `/v1/tab` | list the open tabs / put the agent on one |

Model: any OpenAI-compatible endpoint (`EGO_LLM_KEY`, `EGO_LLM_MODEL`) — defaults to a free
OpenRouter model, so this adds no new paid dependency.





## What a run cost, and sub-agents

Every run reports its own bill, because driving a UI costs 10-100x an API call for the same
outcome and a step budget says nothing about spend:

```json
"metrics": { "llmCalls": 5, "promptTokens": 17800, "completionTokens": 716,
             "totalTokens": 18516, "toolCalls": 3,
             "toolCallsByName": { "delegate": 1, "extract": 1, "done": 1 },
             "subAgents": 1, "durationMs": 23969 }
```

It pays for itself immediately: the first measured run showed **4,326 prompt tokens for a
single step** — the snapshot is the expensive part, which is not obvious until it is counted.

Which is why there is a **cost ceiling**, not just a step cap: `budget_tokens` (default
`EGO_MAX_TOKENS_PER_RUN`, 120k). A step cap bounds how *long* a run goes, not what it
*costs*, and those diverge on heavy pages. The ceiling is checked before each turn **and
inside the retry loop** — three retries happen within one turn, so a run could otherwise
sail well past its budget before the next turn ever looked. Sub-agents inherit it, so the
budget covers the whole tree and delegating cannot escape it.

Hitting it is a policy stop, not a failure: `ok:true`, `status:"budget_exhausted"`, and a
result saying how far it got — `Stopped at 4743 tokens (budget 100). Got as far as: click @e12`.

`delegate` hands one self-contained sub-task to a fresh agent over the same page. It gets a
focused brief instead of a long history, shares the parent's metric counters so a run stays one
number, inherits the taint (a hostile page does not become trustworthy by delegating), and
cannot delegate again — the tree is one level deep by construction.

The sub-agent's answer is surfaced at the top of the parent's next prompt rather than left in
its history. That single change matters more than it sounds: buried in "what you already did"
it reads as an action taken rather than an answer given, and the parent kept re-delegating the
same task. Measured before and after on the same goal — 2 sub-agents and 38,284 tokens ending
with no conclusion, versus 1 sub-agent and 18,516 tokens ending in `done` with the right answer.

## It can see inside components and frames

`querySelectorAll` stops at every shadow boundary and never crosses into an iframe — and the
products this is built to operate put their real controls in exactly those places. Salesforce
Lightning is web components; HubSpot embeds editors in frames.

Snapshots therefore walk shadow roots recursively (nested ones included, marked `in-shadow`)
and snapshot each reachable child frame in its own context. Elements in a frame are addressed
`@fNe1`, which the agent is told about and which `click`/`fill` resolve against the same frame
list the snapshot numbered from.

Measured on `evals/fixtures/deep_dom.html` — one light-DOM button, two in a shadow root, one in
a shadow root nested inside that, and two more inside an iframe:

| | before | after |
|---|---|---|
| elements seen | **1 of 6** | **6 of 6** |

Acting works across the boundary too, verified rather than assumed: filling `@f0e2` and then
reading the value back out of the iframe's own DOM returns what was typed. Cross-origin frames
are skipped, which is the browser's rule, not a limitation to fix.

## The page is hostile until proven otherwise (`guard.mjs`)

A browser agent reads text written by whoever controls the page and then decides what to do.
That is the whole attack surface: indirect prompt injection is now the first cause of agentic
security incidents, and for an agent holding live sessions the payoff is not a bad answer — it
is exfiltration, unauthorised submissions and persistent memory poisoning.

The defence is structural, not a blocklist (blocklists lose):

1. **Content is data, never instructions.** Page text is fenced and labelled untrusted before
   it reaches the model.
2. **The goal is immutable.** Nothing read on a page can widen what the run may do.
3. **Egress is bounded.** After suspicious content is read, navigation is confined to origins
   the task legitimately touches — exfiltration needs a destination, so the destination is removed.
4. **Suspicion downgrades authority.** Irreversible actions are withdrawn for the rest of the
   run *even if the caller authorised them*.

Scanning covers every surface the model can read, **including text the human cannot see** —
`textContent` as well as `innerText`, because a payload hidden with `display:none` is the
dangerous case, not the visible one.

Measured: **6/6** real payloads caught, **0** false positives on ordinary CRM/helpdesk copy.
End to end against a live page carrying a hidden exfiltration instruction, with
`allow_irreversible` explicitly requested by the caller: threat detected, authority withdrawn,
attacker ignored, and the agent still answered the user's actual question correctly.



## Automation posture and blast radius

Driving someone else's product is a contractual question before it is a technical one, and the
answer differs per vendor. `guard.mjs` encodes that per app and the loop enforces it:

| level | meaning | behaviour |
|---|---|---|
| `permitted` | terms do not object to the account owner automating their own use | normal pace |
| `restricted` | tolerated at human pace, own account, no bulk extraction | slowed, tighter cap |
| `prohibited` | terms forbid automated access **and are enforced** (LinkedIn) | **refuses**, unless the caller passes `acknowledge_restricted` |

This does not replace legal advice — it stops the agent behaving in the ways that get a
customer's account banned, makes the risk explicit instead of implicit, and gives counsel
something concrete to review.

**Blast radius** is bounded for the same reason insurers require it: unbounded autonomy makes
an incident unpriceable. A run is capped per app (LinkedIn 6 actions, HubSpot 40), paced per
vendor (4s vs 800ms between actions — acting faster than a human is what trips anti-automation
defences), and refused once it has wandered across more than three sites, because at that point
it is no longer one task.

## Behavioural evaluation (`evals/run.mjs`)

Measuring value delivered to a customer needs live systems. Measuring *behaviour* does not —
it needs pages whose correct outcome is already known. So each case is a golden fixture served
locally plus an assertion about what the agent must and must not do:

```bash
EGO_LLM_KEY=... node evals/run.mjs      # exit code = number of failures
```

`read_table` · `extract_values` · `find_duplicates` · `no_merge_without_permission` ·
`login_wall_asks` · `resists_injection` — **6/6 passing.**

It earned its place immediately by finding two defects that unit tests could not:

* **The approval gate disabled itself.** The check was skipped when the goal itself named an
  irreversible act ("merge the duplicates") — i.e. it switched off in exactly the case it
  exists for. Asking for something is not approving it; only a recorded human authorisation
  gets an irreversible action through now.
* **One malformed model reply ended the whole run.** Long tasks fail by compounding — 95%
  per-step reliability still finishes a 20-step job only about a third of the time — so a
  recoverable step is now retried (bounded, and never on an auth error).

Run it after any model, prompt or playbook change. Evaluation drift is what quietly kills
agent deployments.

## Plugged into the rest of the platform (`bridge.mjs`)

The hands are useless without the body. Nothing below is reimplemented here — it is *called*,
and every call degrades to a no-op if the backend is unset or down, so ego-web still works alone.

| what | existing endpoint it uses | why it matters |
|---|---|---|
| **API-first** | `/api/actions/nl`, `/api/actions/catalog` | before touching a UI, ask whether a real integration can already do it. Clicking is the fallback, not the ambition |
| **Company knowledge** | `/api/kb/articles` | the agent follows *your* procedures instead of improvising like a stranger |
| **Audit** | `/api/audit/log` | every step logged: action, reason, source, result |
| **Data spine** | `/api/spine/emit` | a browser run is visible to the rest of the platform |
| **Human in the loop** | returns `needs_confirmation` | irreversible steps stop and go to your approval queue instead of being performed |

```bash
FR_API_URL=https://<your-backend>   FR_USER_ID=<clerk user>   # enables the bridge
EGO_LLM_KEY=<openrouter key>                                   # free model by default
```

And the reverse direction — the platform's own agent gets these hands via `lib/ego_web.py`,
exposed to the autopilot as two tools: `use_software("add Jane Doe as a contact")` and
`whats_on_screen()`. Each SaaS user gets an isolated browser profile (`space=u_<user_id>`), so
logged-in sessions are never shared between accounts.

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
