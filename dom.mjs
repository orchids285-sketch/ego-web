/**
 * dom.mjs — how the agent sees a page, and how it points back at one element.
 *
 * This lives on its own for one reason: the eval harness used to carry its own copy of the
 * snapshot script and of resolve(). The copy drifted — it had no shadow-DOM walk, no frame
 * traversal and no durable refs — so the evals were quietly grading a weaker agent than the
 * one that ships, and would have passed a build whose real grounding was broken. Evaluation
 * drift is the failure mode that kills agent programmes, and a duplicated fixture is how it
 * starts. One definition, imported by both.
 */

/* ───────────────────────────── snapshot: the @eN ref map ─────────────────────────────
 * The single most important agent affordance: a compact, numbered list of what is actually
 * interactive, so the model targets @e7 instead of inventing a selector.
 */
export const SNAPSHOT_JS = `(() => {
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
  // Walk shadow roots as well as the light DOM. querySelectorAll stops at every shadow
  // boundary, and the products this agent is meant to operate — Salesforce Lightning,
  // HubSpot, anything built on web components — put their real controls inside those
  // boundaries. Without this the page looks almost empty and the agent is blind to it.
  const collect = (root, depth) => {
    if (depth > 12) return;                     // pathological nesting guard
    let nodes;
    try { nodes = root.querySelectorAll(SEL); } catch (e) { return; }
    nodes.forEach((el) => {
      if (!vis(el) || el.disabled) return;
      const i = refs.length + 1; refs.push(el);
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type');
      const extra = [type ? 'type=' + type : '',
                     el.getAttribute('href') ? 'href=' + el.getAttribute('href').slice(0, 60) : '',
                     depth ? 'in-shadow' : ''].filter(Boolean).join(' ');
      out.push('@e' + i + ' <' + tag + (extra ? ' ' + extra : '') + '> ' + JSON.stringify(label(el)));
    });
    let hosts;
    try { hosts = root.querySelectorAll('*'); } catch (e) { return; }
    hosts.forEach((el) => { if (el.shadowRoot) collect(el.shadowRoot, depth + 1); });
  };
  collect(document, 0);
  window.__egoRefs = refs;
  // A live element handle dies the moment the framework re-renders — React swaps the node and
  // every ref taken before it points at detached DOM. So each ref also gets a durable address
  // that can be resolved again afterwards: a positional path in the light DOM, and for shadow
  // content a chain of host hops, since a path cannot cross a shadow boundary.
  const addressOf = (el) => {
    const seg = (n) => {
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
        if (s.tagName === n.tagName) i++;
      }
      return n.tagName.toLowerCase() + '[' + i + ']';
    };
    const chain = [];
    let node = el;
    while (node) {
      const root = node.getRootNode();
      const parts = [];
      for (let n = node; n && n.nodeType === 1; n = n.parentElement) parts.unshift(seg(n));
      chain.unshift({ shadow: root instanceof ShadowRoot, path: '/' + parts.join('/') });
      node = root instanceof ShadowRoot ? root.host : null;
    }
    return chain;
  };
  window.__egoAddrs = refs.map((el) => { try { return addressOf(el); } catch (e) { return null; } });
  const heading = (document.querySelector('h1')?.innerText || '').trim().slice(0, 120);
  // Body text matters for two reasons: the agent usually needs it to answer, and it is the
  // surface indirect prompt injection actually hides in. innerText omits display:none, so
  // textContent is taken too - a payload the human cannot see is exactly the dangerous case.
  const shown = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
  const raw = (document.body?.textContent || '').replace(/\\s+/g, ' ').trim();
  const hiddenExtra = raw.length > shown.length ? raw.slice(0, 4000) : '';
  return { url: location.href, title: document.title, heading, count: refs.length,
           elements: out.join('\\n'), text: shown.slice(0, 4000), hidden_text: hiddenExtra };
})()`;

/** Child frames only, in a stable order. snapshotPage() numbers refs from this list and
 *  resolve() reads from the same one — indexing the raw page.frames() there instead put @f0 on
 *  the main frame, so every in-frame ref silently addressed the wrong document. */
export const childFrames = (page) => page.frames().filter((f) => f !== page.mainFrame());

/**
 * Snapshot a page AND its child frames.
 *
 * An iframe is a separate document, so a single evaluate() only ever sees the top one — and
 * the apps this agent works in put whole features inside frames (HubSpot editors, embedded
 * checkouts, help widgets). Each frame is snapshotted in its own context and its refs are
 * addressed `@f<frame>e<n>`, so a ref stays unambiguous about where it lives.
 */
export async function snapshotPage(page) {
  const main = await page.evaluate(SNAPSHOT_JS);
  const frames = childFrames(page);
  const parts = [];
  let frameCount = 0;
  for (let i = 0; i < frames.length && frameCount < 8; i++) {
    try {
      const f = frames[i];
      if (!f.url() || f.url() === 'about:blank') continue;
      const sub = await f.evaluate(SNAPSHOT_JS);          // throws on cross-origin: skipped
      if (!sub || !sub.count) continue;
      frameCount++;
      const renumbered = sub.elements.split('\n')
        .map((l) => l.replace(/^@e(\d+)/, (_, n) => `@f${i}e${n}`))
        .join('\n');
      parts.push(`--- frame ${i} (${f.url().slice(0, 80)}) ---\n${renumbered}`);
      main.count += sub.count;
      if (sub.text) main.text = (main.text || '') + '\n' + sub.text;
      if (sub.hidden_text) main.hidden_text = (main.hidden_text || '') + '\n' + sub.hidden_text;
    } catch { /* cross-origin frame: not reachable, and that is expected */ }
  }
  if (parts.length) main.elements += '\n' + parts.join('\n');
  main.frames = frameCount;
  return main;
}

/** Re-find an element from its durable address after the live handle has gone stale.
 *  Runs in the page: walks the host chain, then the element path within each root. */
const REHYDRATE = (chain) => {
  if (!chain || !chain.length) return null;
  let root = document;
  let el = null;
  for (const hop of chain) {
    const parts = hop.path.split('/').filter(Boolean);
    let cur = root;
    for (const p of parts) {
      const m = /^([a-z0-9-]+)\[(\d+)\]$/i.exec(p);
      if (!m || !cur) return null;
      const kids = Array.from(cur.children || [])
        .filter((c) => c.tagName.toLowerCase() === m[1].toLowerCase());
      cur = kids[Number(m[2]) - 1] || null;
    }
    el = cur;
    if (!el) return null;
    root = el.shadowRoot || el;                 // next hop starts inside this host
  }
  return el;
};

/** Look a ref up in one document: live handle first, durable address second.
 *  The live node is preferred — it is exact. The address only runs when that node has left
 *  the document, which is precisely the re-render case a stored handle cannot survive. */
async function lookup(ctx, index, rehydrateSrc) {
  const h = await ctx.evaluateHandle(([i, src]) => {
    const el = (window.__egoRefs || [])[i];
    if (el && el.isConnected) return el;
    const addr = (window.__egoAddrs || [])[i];
    if (!addr) return null;
    try { return (0, eval)('(' + src + ')')(addr); } catch (e) { return null; }
  }, [index, rehydrateSrc]);
  return h.asElement();
}

export async function resolve(page, ref) {
  const r = String(ref).trim();
  const src = REHYDRATE.toString();
  const stale = `ref ${r} not found — the page changed past recovery, take a fresh snapshot()`;
  // `@f<frame>e<n>` addresses an element inside a child frame; `@e<n>` the top document.
  const inFrame = /^@f(\d+)e(\d+)$/.exec(r);
  if (inFrame) {
    const f = childFrames(page)[Number(inFrame[1])];   // same list snapshotPage() numbered from
    if (!f) throw new Error(`frame ${inFrame[1]} is gone — take a fresh snapshot()`);
    const el = await lookup(f, Number(inFrame[2]) - 1, src);
    if (!el) throw new Error(stale);
    return el;
  }
  const m = /^@e(\d+)$/.exec(r);
  if (!m) return page.locator(r); // plain CSS/text selector still works
  const el = await lookup(page, Number(m[1]) - 1, src);
  if (!el) throw new Error(stale);
  return el;
}
