/**
 * mcp.mjs — expose the browser as MCP tools.
 *
 * MCP settled the agent-to-tool layer: Anthropic donated it to the Linux Foundation in
 * December 2025 with OpenAI, AWS, Google and Microsoft aboard. ego lite ships as a Codex and
 * Claude Code plugin for exactly this reason, and Browser Operator carries its own MCP client.
 * Speaking it means any host — Claude Code, Codex, the platform's own MCP server — can drive
 * this browser without a bespoke integration, and the logged-in sessions come with it.
 *
 * Deliberately a plain JSON-RPC handler over HTTP rather than an SDK: the protocol surface
 * needed here is three methods, and adding a dependency to a service whose whole job is to run
 * a browser is not a trade worth making.
 *
 *   initialize   → capabilities + server identity
 *   tools/list   → the catalogue below
 *   tools/call   → run one, returning MCP content blocks
 */

export const PROTOCOL_VERSION = '2025-06-18';

/** The catalogue. Descriptions matter more than names here — they are the only thing a host
 *  model reads when deciding what to reach for. */
export const TOOLS = [
  {
    name: 'browser_open',
    description: 'Open a URL in the user\'s logged-in browser session and report the page title. '
      + 'Sessions persist per space, so sites the user has already signed into stay signed in.',
    inputSchema: { type: 'object', required: ['url'], properties: {
      url: { type: 'string', description: 'Absolute URL to open' },
      space: { type: 'string', description: 'Browser profile to use; defaults to "default"' } } },
  },
  {
    name: 'browser_snapshot',
    description: 'Return a numbered map of everything interactive on the current page (@e1, @e2, …), '
      + 'including inside shadow DOM and embedded frames (@f0e1). Take this before clicking: the '
      + 'refs are how you target elements, and they change after every action.',
    inputSchema: { type: 'object', properties: {
      space: { type: 'string' } } },
  },
  {
    name: 'browser_click',
    description: 'Click one element by its @ref from the latest snapshot.',
    inputSchema: { type: 'object', required: ['ref'], properties: {
      ref: { type: 'string', description: 'A ref such as @e5 or @f0e2' },
      space: { type: 'string' } } },
  },
  {
    name: 'browser_fill',
    description: 'Type text into one field by its @ref from the latest snapshot.',
    inputSchema: { type: 'object', required: ['ref', 'text'], properties: {
      ref: { type: 'string' }, text: { type: 'string' }, space: { type: 'string' } } },
  },
  {
    name: 'browser_do',
    description: 'Give the browser a goal in plain language and let it work: it observes, acts and '
      + 'verifies on its own, using per-app knowledge for HubSpot, Salesforce, Notion, Gmail and '
      + 'others. Returns what it did, what it cost, and any security issue it met. Irreversible '
      + 'actions (send, pay, delete, merge) stop for a human unless explicitly authorised.',
    inputSchema: { type: 'object', required: ['goal'], properties: {
      goal: { type: 'string', description: 'What to accomplish, in plain language' },
      space: { type: 'string' },
      max_steps: { type: 'number', description: 'Step ceiling for this run' },
      budget_tokens: { type: 'number', description: 'Token ceiling for this run' },
      allow_irreversible: { type: 'boolean',
        description: 'Only set when a human has approved this specific irreversible action' } } },
  },
  {
    name: 'browser_context',
    description: 'Report which application the current page belongs to and what this browser '
      + 'already knows how to do there. Worth calling before planning work in an unfamiliar app.',
    inputSchema: { type: 'object', properties: { space: { type: 'string' } } },
  },
  {
    name: 'browser_tabs',
    description: 'List the tabs currently open, with the app recognised for each.',
    inputSchema: { type: 'object', properties: { space: { type: 'string' } } },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const fail = (s) => ({ ...text(s), isError: true });

/**
 * Run one tool. `deps` are the server's own primitives, passed in so this file stays free of
 * browser plumbing and can be tested on its own.
 */
export async function callTool(name, args = {}, deps) {
  const { makeFacades, snapshot, runGoal, assist } = deps;
  const space = args.space || 'default';
  const f = makeFacades(space, []);

  switch (name) {
    case 'browser_open': {
      if (!args.url) return fail('url is required');
      const r = await f.page.goto(String(args.url));
      return text(`Opened ${r.url} — "${r.title}"`);
    }
    case 'browser_snapshot': {
      const s = await snapshot(space);
      return text(`${s.title} — ${s.url}\n${s.count} interactive element(s)`
        + (s.frames ? `, ${s.frames} frame(s) traversed` : '') + `\n\n${s.elements}`);
    }
    case 'browser_click': {
      if (!args.ref) return fail('ref is required');
      await f.page.click(String(args.ref));
      const after = await f.page.info();
      return text(`Clicked ${args.ref}. Now on ${after.url}. Take a fresh snapshot — refs have changed.`);
    }
    case 'browser_fill': {
      if (!args.ref) return fail('ref is required');
      await f.page.fill(String(args.ref), String(args.text ?? ''));
      return text(`Filled ${args.ref}.`);
    }
    case 'browser_do': {
      if (!args.goal) return fail('goal is required');
      const out = await runGoal({
        page: f.page, goal: String(args.goal),
        maxSteps: Number(args.max_steps) || undefined,
        budgetTokens: Number(args.budget_tokens) || undefined,
        allowIrreversible: !!args.allow_irreversible,
      });
      const m = out.metrics || {};
      const lines = [
        `status: ${out.status || (out.ok ? 'done' : 'failed')}`,
        `result: ${out.result || out.error || '(none)'}`,
        out.app ? `app: ${out.app}` : '',
        (out.steps || []).length ? `steps:\n  ${(out.steps || []).join('\n  ')}` : '',
        m.totalTokens ? `cost: ${m.totalTokens} tokens over ${m.llmCalls} call(s), ${m.durationMs}ms` : '',
        (out.threats || []).length
          ? `SECURITY: the page tried to instruct the agent; irreversible actions were withdrawn.` : '',
      ].filter(Boolean);
      // A run that stopped for a human is not an error — the host should show it and ask.
      return out.ok === false ? fail(lines.join('\n')) : text(lines.join('\n'));
    }
    case 'browser_context': {
      const a = await assist(f.page);
      return text({ app: a.app, knows_app: a.knows_app, notes: a.notes,
                    tasks: (a.tasks || []).map((t) => t.label) });
    }
    case 'browser_tabs':
      return text(await f.browser.tabs());
    default:
      return fail(`unknown tool "${name}"`);
  }
}

/** Handle one JSON-RPC message. Returns the response object, or null for a notification. */
export async function handle(msg, deps, serverName = 'ego-web') {
  const id = msg?.id;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (msg?.method) {
    case 'initialize':
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: serverName, version: '1.0.0' },
        instructions: 'A real browser holding the user\'s logged-in sessions. Snapshot before '
          + 'clicking; refs change after every action. Irreversible actions stop for a human.',
      });
    case 'notifications/initialized':
      return null;                                  // notification: no reply by protocol
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args } = msg.params || {};
      if (!name) return err(-32602, 'params.name is required');
      try {
        return ok(await callTool(name, args || {}, deps));
      } catch (e) {
        // A tool that throws is reported as tool failure, not as a broken protocol — the host
        // should be able to read the reason and try something else.
        return ok(fail(String(e?.message || e).slice(0, 400)));
      }
    }
    default:
      return err(-32601, `method not found: ${msg?.method}`);
  }
}
