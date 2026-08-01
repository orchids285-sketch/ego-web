/**
 * agent.mjs — the loop that turns this browser into a worker.
 *
 * Not "an extension that reads your tabs". A real employee loop:
 *
 *     observe (@eN snapshot)  ->  decide (LLM briefed with the app's playbook)
 *          ->  act (click / fill / press / goto)  ->  verify (fresh snapshot)  ->  repeat
 *
 * The point: the user's existing SaaS — HubSpot, Salesforce, Notion — stops being a place
 * they must go and operate by hand. It becomes a surface this agent operates for them.
 * Their competitors turn into the agent's hands.
 *
 * Safety is part of the design, not a bolt-on: the model is told which actions are
 * irreversible, and the loop stops and asks instead of sending, paying or deleting.
 */
import { detect, brief, findTask } from './playbooks.mjs';

const LLM_URL = process.env.EGO_LLM_URL || 'https://openrouter.ai/api/v1/chat/completions';
const LLM_KEY = process.env.EGO_LLM_KEY || process.env.OPENROUTER_API_KEY || '';
const LLM_MODEL = process.env.EGO_LLM_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';
const MAX_STEPS = Number(process.env.EGO_MAX_STEPS || 14);

export function llmReady() { return Boolean(LLM_KEY); }

async function think(system, user, maxTokens = 500) {
  const r = await fetch(LLM_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + LLM_KEY,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://foundreach-app.vercel.app',
      'X-Title': 'ego-web',
    },
    body: JSON.stringify({
      model: LLM_MODEL, max_tokens: maxTokens, temperature: 0.1, stream: false,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`llm ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j?.choices?.[0]?.message?.content || '';
}

function parseJson(txt) {
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(txt.slice(s, e + 1)); } catch { return null; }
}

const IRREVERSIBLE = /\b(send|pay|refund|delete|remove|archive|cancel|unsubscribe|publish|merge|invite|charge)\b/i;

const SYSTEM = `You operate a real web browser on behalf of a professional. You are not a chatbot:
you look at the page, take ONE action, then look again.

You receive a numbered map of the interactive elements (@e1, @e2, ...). Target elements ONLY by
those refs. The map changes after every action — never reuse an old ref.

Reply with STRICT JSON, one action:
{"thought":"<one short line>","action":"click|fill|press|goto|scroll|extract|ask|done",
 "ref":"@eN","text":"...","url":"...","result":"..."}

- click   : press @ref
- fill    : put "text" into @ref (clears it first)
- press   : a key like Enter, Tab, Escape
- goto    : navigate to "url"
- scroll  : reveal more of the page
- extract : you have read what was asked; put the answer in "result"
- ask     : you need a human decision; explain in "result"
- done    : the goal is achieved; summarise in "result"

RULES
1. One action per reply. No commentary outside the JSON.
2. Prefer the app's own search/filter over hunting through pages.
3. NEVER perform an irreversible action (send, pay, refund, delete, merge, publish, invite)
   unless the goal explicitly authorises it. Use "ask" instead.
4. If a page looks like a login wall, use "ask" — never guess credentials.
5. If two actions in a row changed nothing, try a different route or "ask".
6. Stop as soon as the goal is met. Do not keep exploring.`;

/**
 * Run a goal on the live page.
 * @param {object} o
 * @param {object} o.page   the page facade from server.mjs
 * @param {string} o.goal
 * @param {number} [o.maxSteps]
 * @param {boolean} [o.allowIrreversible]
 * @param {(s:object)=>void} [o.onStep]
 */
export async function runGoal({ page, goal, maxSteps = MAX_STEPS, allowIrreversible = false, onStep }) {
  if (!llmReady()) return { ok: false, error: 'no LLM key configured (EGO_LLM_KEY / OPENROUTER_API_KEY)' };

  const trail = [];
  let last = '';

  for (let step = 1; step <= maxSteps; step++) {
    const snap = await page.snapshot();
    const pb = detect(snap.url);

    const user = [
      `GOAL: ${goal}`,
      allowIrreversible ? 'The user HAS authorised irreversible actions for this goal.' : '',
      '',
      brief(pb),
      '',
      `CURRENT PAGE: ${snap.title} — ${snap.url}`,
      `INTERACTIVE ELEMENTS (${snap.count}):`,
      snap.elements.slice(0, 6000) || '(none visible — try scroll)',
      trail.length ? `\nWHAT YOU ALREADY DID:\n${trail.slice(-6).map((t, i) => `${i + 1}. ${t}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');

    let decision;
    try {
      decision = parseJson(await think(SYSTEM, user));
    } catch (e) {
      return { ok: false, error: String(e.message).slice(0, 200), steps: trail, app: pb.name };
    }
    if (!decision?.action) return { ok: false, error: 'model returned no action', steps: trail, app: pb.name };

    const { action, ref, text, url, result, thought } = decision;
    const line = `${action}${ref ? ' ' + ref : ''}${text ? ' "' + String(text).slice(0, 40) + '"' : ''}${url ? ' ' + url : ''}`;
    onStep?.({ step, thought, action, ref, text, url, page: snap.url });

    // Safety gate — the model can propose it, the loop still refuses it.
    if (!allowIrreversible && (IRREVERSIBLE.test(goal) === false) && ref) {
      const label = (snap.elements.split('\n').find((l) => l.startsWith(ref + ' ')) || '');
      if (action === 'click' && IRREVERSIBLE.test(label)) {
        return { ok: true, status: 'needs_confirmation', app: pb.name, steps: trail,
                 result: `About to ${label.trim()} — that is irreversible. Confirm and I will finish.` };
      }
    }

    try {
      if (action === 'done' || action === 'extract')
        return { ok: true, status: 'done', app: pb.name, steps: trail, result: result || thought || 'done' };
      if (action === 'ask')
        return { ok: true, status: 'needs_input', app: pb.name, steps: trail, result: result || thought || 'need a decision' };
      if (action === 'click') await page.click(ref);
      else if (action === 'fill') await page.fill(ref, text ?? '');
      else if (action === 'press') await page.press(text || 'Enter');
      else if (action === 'goto') await page.goto(url);
      else if (action === 'scroll') await page.scroll(700);
      else return { ok: false, error: `unknown action ${action}`, steps: trail, app: pb.name };
      trail.push(line);
    } catch (e) {
      trail.push(`${line} -> FAILED: ${String(e.message).slice(0, 90)}`);
      if (line === last) return { ok: false, error: 'stuck repeating a failing action', steps: trail, app: pb.name };
    }
    last = line;
    await new Promise((r) => setTimeout(r, 400));   // let the app settle; also keeps us human-paced
  }
  return { ok: true, status: 'max_steps', steps: trail, result: 'Reached the step limit without finishing.' };
}

/** Run one named task from the current app's playbook. */
export async function runTask({ page, taskId, inputs = {}, allowIrreversible = false, onStep }) {
  const info = await page.info();
  const pb = detect(info.url);
  const task = findTask(pb, taskId);
  if (!task) return { ok: false, error: `unknown task "${taskId}" for ${pb.name}` };
  const goal = [
    task.goal,
    Object.keys(inputs).length ? `INPUTS: ${JSON.stringify(inputs)}` : '',
    `HOW THIS IS NORMALLY DONE IN ${pb.name}:\n- ${task.steps.join('\n- ')}`,
  ].filter(Boolean).join('\n');
  return runGoal({ page, goal, allowIrreversible: allowIrreversible && !task.confirm, onStep });
}

/** What can the agent do on the page currently open? */
export async function assist(page) {
  const info = await page.info();
  const pb = detect(info.url);
  return {
    app: pb.name, app_id: pb.id, url: info.url, title: info.title,
    knows_app: pb.id !== 'generic',
    notes: pb.notes || [],
    tasks: pb.tasks.map((t) => ({ id: t.id, label: t.label, inputs: t.inputs || [], needs_confirmation: !!t.confirm })),
  };
}
