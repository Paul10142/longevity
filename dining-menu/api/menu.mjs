// Vercel serverless route: GET /api/menu?date=YYYY-MM-DD
// Serves the menus saved by scripts/refresh-menus.mjs (Vercel itself can't reach the UVM site).
import { readFile } from 'node:fs/promises';

const FILE = new URL('../data/menus.json', import.meta.url);

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const date = url.searchParams.get('date') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'date must look like 2026-10-25' }));
  }

  const saved = JSON.parse(await readFile(FILE, 'utf8'));
  const day = saved.days[date];
  const halls = day
    ? day.halls
    : saved.halls.map(h => ({ ...h, stations: null, error: 'No saved menu for this day yet.', checkedAt: saved.generatedAt }));

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(JSON.stringify({ date, halls }));
}
