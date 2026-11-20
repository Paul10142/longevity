// Run on your Mac (not on Vercel): saves the next 21 days of dinner menus to
// data/menus.json, then republishes the site. Cloudflare blocks Vercel's servers,
// but a home connection gets through.
// Usage: node dining-menu/scripts/refresh-menus.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getMenus, HALLS } from '../lib/menus.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const DAYS_AHEAD = 21;
const PAUSE_MS = 1500;      // be gentle with the UVM site
const MIN_SUCCESS = 0.9;    // don't publish if most requests failed

const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const days = {};
let ok = 0;
let total = 0;
const today = new Date();
for (let i = 0; i <= DAYS_AHEAD; i++) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
  const date = fmt(d);
  const halls = await getMenus(date);
  total += halls.length;
  ok += halls.filter(h => !h.error).length;
  days[date] = { halls };
  process.stdout.write(`${date} ${halls.map(h => (h.error ? 'ERR' : (h.stations ? 'ok' : 'none'))).join(' ')}\n`);
  if (i < DAYS_AHEAD) await sleep(PAUSE_MS);
}

const rate = ok / total;
if (rate < MIN_SUCCESS) {
  console.error(`Only ${ok} of ${total} requests worked. Not publishing; the site keeps the last good menus.`);
  process.exit(1);
}

const generatedAt = new Date().toISOString();
await mkdir(join(root, 'data'), { recursive: true });
await writeFile(join(root, 'data', 'menus.json'), JSON.stringify({ generatedAt, halls: HALLS, days }, null, 1));
console.log(`Saved ${Object.keys(days).length} days (${ok}/${total} hall-days ok).`);

const { stdout } = await run('vercel', ['deploy', '--prod', '--yes', '--name', 'dining-menu-compare'], { cwd: root });
console.log(stdout.split('\n').filter(l => /Aliased|Error/i.test(l)).join('\n') || 'Deployed.');
