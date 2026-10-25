// Serves the dinner menu page and fetches the three dining halls live from
// dining.umich.edu. No dependencies: run with `node dining-menu/server.mjs`.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const CACHE_MS = 15 * 60 * 1000;

const HALLS = [
  { id: 'mosher-jordan', name: 'Mosher Jordan' },
  { id: 'east-quad', name: 'East Quad' },
  { id: 'south-quad', name: 'South Quad' },
];

const cache = new Map();

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&rsquo;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pulls the Dinner section out of a dining hall page and returns its stations.
// Returns null when the page has no Dinner section for that day.
function parseDinner(html) {
  const heading = /<h3><a[^>]*>[\s\S]*?<\/i>\s*([^<]+?)\s*<\/a><\/h3>/g;
  const marks = [...html.matchAll(heading)];
  for (let i = 0; i < marks.length; i++) {
    if (marks[i][1].trim() !== 'Dinner') continue;
    const end = marks[i + 1]?.index ?? html.length;
    const body = html.slice(marks[i].index + marks[i][0].length, end);
    return body.split(/<h4>/).slice(1).map(chunk => ({
      station: stripTags(chunk.split('</h4>')[0]),
      items: [...chunk.matchAll(/<span class="item-name">([\s\S]*?)<\/span>/g)]
        .map(m => stripTags(m[1]))
        .filter(Boolean),
    }));
  }
  return null;
}

async function loadHall(hall, date) {
  const key = `${hall.id}|${date}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const url = `https://dining.umich.edu/menus-locations/dining-halls/${hall.id}/?menuDate=${date}`;
  let value;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 dining-menu-page' } });
    if (!res.ok) throw new Error(`UVM site returned ${res.status}`);
    const stations = parseDinner(await res.text());
    value = { ...hall, stations, error: null, checkedAt: new Date().toISOString() };
  } catch (err) {
    // A failed fetch is not cached, so the next request tries again.
    return { ...hall, stations: null, error: err.message, checkedAt: new Date().toISOString() };
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function handleMenu(url, res) {
  const date = url.searchParams.get('date') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'date must look like 2026-10-25' }));
  }
  const halls = await Promise.all(HALLS.map(h => loadHall(h, date)));
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ date, halls }));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/menu') return await handleMenu(url, res);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const page = await readFile(join(here, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Dinner menus running at http://localhost:${PORT}`);
});
