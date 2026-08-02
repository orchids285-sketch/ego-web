/**
 * A skill's approval list must WIDEN the agent's stops, never narrow them.
 *
 * The built-in list is a generic verb regex — send, pay, delete, merge. A company's own
 * jobs stop on things that list cannot anticipate ("approve", "escalate", "assign"),
 * because those are irreversible in their process, not in English. So the two are unioned:
 * a skill can add a stop and can never remove one.
 *
 *   node evals/skill_stops.mjs
 */

// Kept identical to agent.mjs. If that changes and this does not, the mismatch is the bug.
const IRREVERSIBLE =
  /\b(send|pay|refund|delete|remove|archive|cancel|unsubscribe|publish|merge|invite|charge)\b/i;

const makeNeedsApproval = (stops) => {
  const list = stops.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  return (label) => {
    const l = String(label).toLowerCase();
    return list.some((v) =>
      new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(l));
  };
};

let pass = 0, total = 0;
const check = (name, cond) => {
  total++;
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else console.log(`  FAIL  ${name}`);
};

console.log("skill-declared approval stops\n");

const needs = makeNeedsApproval(["approve", "escalate", "assign owner"]);
const stops = (label) => IRREVERSIBLE.test(label) || needs(label);

check("a built-in verb still stops",
      stops('@e1 <button> "Send invoice"'));
check("a skill-declared stop is honoured",
      stops('@e2 <button> "Approve request"'));
check("vocabulary a generic verb list would miss",
      stops('@e3 <button> "Escalate to owner"'));
check("a multi-word declared stop matches",
      stops('@e4 <button> "Assign owner"'));
check("an ordinary action still proceeds",
      !stops('@e5 <button> "Open details"'));
check("word boundaries hold — 'Approved' is not 'approve'",
      !stops('@e6 <button> "Approved filter"'));

// The empty case is the one that would quietly disable the guard.
const none = makeNeedsApproval([]);
check("with no skill, the built-in list still stops on its own",
      IRREVERSIBLE.test('@e7 <button> "Delete contact"') || none('@e7 <button> "Delete contact"'));
check("with no skill, an ordinary action is not stopped",
      !(IRREVERSIBLE.test('@e8 <button> "View"') || none('@e8 <button> "View"')));

// A skill must not be able to switch a stop off.
const weird = makeNeedsApproval(["", "   "]);
check("blank entries in a skill list cannot match everything",
      !weird('@e9 <button> "Open details"'));

console.log(`\n${pass}/${total}`);
process.exitCode = pass === total ? 0 : 1;
