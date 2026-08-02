/**
 * Does a ref survive a re-render?
 * Snapshot, wait for the page to rebuild its DOM, then act on the ref taken beforehand.
 * Before durable addresses this was a guaranteed failure: the stored handle is detached.
 */
import { chromium } from 'playwright';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { snapshotPage, resolve } from '../dom.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = pathToFileURL(path.join(here, 'fixtures', 'rerender.html')).href;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url);

const snap = await snapshotPage(page);
console.log(snap.elements);

await page.waitForTimeout(600);                        // the re-render lands here
const detached = await page.evaluate(() => !(window.__egoRefs || [])[0]?.isConnected);
console.log(`\nhandle detached after re-render: ${detached}`);

let pass = 0, total = 0;
const check = (name, cond) => { total++; if (cond) { pass++; console.log(`  PASS  ${name}`); }
                                else console.log(`  FAIL  ${name}`); };

// light DOM
try {
  const el = await resolve(page, '@e2');
  await el.click();
  const out = await page.textContent('#out');
  check('light-DOM ref still clicks the right row after re-render', out === 'opened Globex');
} catch (e) { check(`light-DOM ref survives (${e.message})`, false); }

// shadow DOM — XPath cannot cross the boundary, the host chain must
try {
  const refs = snap.elements.split('\n').find((l) => /Shadow action/.test(l));
  const ref = /@(e\d+)/.exec(refs)[1];
  const el = await resolve(page, '@' + ref);
  await el.click();
  const out = await page.textContent('#out');
  check('shadow-DOM ref still clicks after re-render', out === 'shadow fired');
} catch (e) { check(`shadow-DOM ref survives (${e.message})`, false); }

// a ref that genuinely cannot be recovered must still fail loudly
try {
  await resolve(page, '@e99');
  check('unrecoverable ref throws', false);
} catch (e) { check('unrecoverable ref throws with a useful message', /fresh snapshot/.test(e.message)); }

console.log(`\n${pass}/${total}`);
await browser.close();
process.exit(pass === total ? 0 : 1);
