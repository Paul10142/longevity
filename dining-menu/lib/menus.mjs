// Fetches dinner menus for the three halls from dining.umich.edu.
// Shared by the local server (server.mjs) and the Vercel route (api/menu.mjs).

export const HALLS = [
  { id: 'mosher-jordan', name: 'Mosher Jordan' },
  { id: 'east-quad', name: 'East Quad' },
  { id: 'south-quad', name: 'South Quad' },
];

const CACHE_MS = 15 * 60 * 1000;
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
export function parseDinner(html) {
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
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`UVM site returned ${res.status}`);
    const stations = parseDinner(await res.text());
    const value = { ...hall, stations, error: null, checkedAt: new Date().toISOString() };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    // A failed fetch is not cached, so the next request tries again.
    return { ...hall, stations: null, error: err.message, checkedAt: new Date().toISOString() };
  }
}

export function getMenus(date) {
  return Promise.all(HALLS.map(h => loadHall(h, date)));
}
