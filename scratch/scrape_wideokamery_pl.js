/**
 * OSIRIS — harvester for the Polish cameras indexed on wideokamery.pl.
 *
 * wideokamery.pl is a catalogue, not a feed: each camera page embeds a Windy
 * player and carries the coordinates the page itself uses for its weather
 * widget (data-lat / data-lng). This walks the country pagination, reads those
 * pages, and emits a generated CctvCamera module.
 *
 *   node scratch/scrape_wideokamery_pl.js
 *
 * Writes scratch/wideokamery-pl.json (raw harvest, committed for reproducibility)
 * and src/app/api/cctv/poland-wideokamery.generated.ts.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://wideokamery.pl';
const HERE = __dirname;
const HARVEST = path.join(HERE, 'wideokamery-pl.json');
const OUT = path.join(HERE, '..', 'src', 'app', 'api', 'cctv', 'poland-wideokamery.generated.ts');
const CONCURRENCY = 6;
const MAX_PAGES = 40;

function get(url, redirects = 0) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'pl,en;q=0.8',
      },
      timeout: 25000,
    }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirects < 5) {
        res.resume();
        const next = new URL(headers.location, url).toString();
        return resolve(get(next, redirects + 1));
      }
      if (statusCode !== 200) {
        res.resume();
        return resolve({ status: statusCode, body: '' });
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: 200, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

async function getWithRetry(url, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    const r = await get(url);
    if (r.status === 200) return r;
    await new Promise((res) => setTimeout(res, 400 * (i + 1)));
  }
  return { status: 0, body: '' };
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function slugOf(url) {
  const m = /\/kamery\/([^/]+)\/?$/.exec(url);
  return m ? m[1] : null;
}

function parseCameraPage(html) {
  const lat = /\bdata-lat="(-?\d+\.?\d*)"/.exec(html);
  const lng = /\bdata-lng="(-?\d+\.?\d*)"/.exec(html);
  if (!lat || !lng) return null;

  let name = null;
  let city = null;
  for (const raw of html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || []) {
    const inner = raw.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    let json;
    try { json = JSON.parse(inner); } catch { continue; }
    for (const node of json['@graph'] || [json]) {
      if (node['@type'] !== 'BreadcrumbList') continue;
      for (const item of node.itemListElement || []) {
        const itemUrl = item.item || '';
        if (/\/miasta\//.test(itemUrl)) city = decodeEntities(item.name);
        else if (/\/kamery\/[^/]+\/?$/.test(itemUrl)) name = decodeEntities(item.name);
      }
    }
  }
  if (!name) {
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
    if (h1) name = decodeEntities(h1[1].replace(/<[^>]+>/g, '')).trim();
  }
  if (!name) return null;

  const embed = /webcams\.windy\.com\/webcams\/public\/embed\/player\/(\d+)/.exec(html);
  const windyId = embed ? embed[1] : null;

  return {
    lat: Number(lat[1]),
    lng: Number(lng[1]),
    name: name.replace(/\s+/g, ' ').trim(),
    city: city || name.split(':')[0].trim(),
    windyId,
  };
}

async function harvest() {
  const seen = new Set();
  const urls = [];

  const collect = (html) => {
    for (const m of html.matchAll(/href="(\/kamery\/[^"#?]+)"/g)) {
      const href = m[1];
      if (href === '/kamery/' || /\/(strona|kategoria|kraj)\//.test(href)) continue;
      const slug = slugOf(href);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      urls.push(`${BASE}/kamery/${slug}/`);
    }
  };

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = page === 1 ? `${BASE}/kraje/pl/` : `${BASE}/kraje/pl/strona/${page}/`;
    const { status, body } = await getWithRetry(url);
    if (status !== 200) {
      if (page === 1) throw new Error(`index page failed (${status})`);
      break;
    }
    const before = urls.length;
    collect(body);
    console.log(`index ${page}: +${urls.length - before} cameras (total ${urls.length})`);
    if (urls.length === before) break;
  }

  console.log(`\n${urls.length} camera pages to read`);

  let done = 0;
  const cams = await pool(urls, CONCURRENCY, async (url) => {
    const { status, body } = await getWithRetry(url);
    done += 1;
    if (done % 50 === 0) console.log(`  ${done}/${urls.length}`);
    if (status !== 200) return null;
    const parsed = parseCameraPage(body);
    if (!parsed) return null;
    return { slug: slugOf(url), url, ...parsed };
  });

  const kept = cams.filter(Boolean);
  console.log(`\nparsed ${kept.length}/${urls.length} (${urls.length - kept.length} lacked coordinates)`);
  fs.writeFileSync(HARVEST, `${JSON.stringify(kept, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), HARVEST)}`);
  return kept;
}

function emit(cams) {
  const rows = cams
    .filter((c) => c.windyId)
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((c) => {
      const q = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return `  { id: 'pl-wok-${c.slug}', lat: ${c.lat}, lng: ${c.lng}, name: '${q(c.name)}', city: '${q(c.city)}', country: 'Poland', stream_url: 'https://webcams.windy.com/webcams/public/embed/player/${c.windyId}/day', stream_type: 'iframe', external_url: '${c.url}', source: 'wideokamery.pl' },`;
    });

  const body = `import type { CctvCamera } from './types';

/**
 * OSIRIS — Polish cameras indexed by wideokamery.pl (GENERATED).
 *
 * wideokamery.pl is a catalogue rather than a broadcaster: every entry points
 * at a Windy player, and the coordinates are the ones the page itself uses for
 * its local weather widget. Nothing here is scraped from a stream — the embed
 * stays on Windy's origin and plays in OSIRIS' iframe viewer.
 *
 * ${rows.length} cameras. Regenerate with scratch/scrape_wideokamery_pl.js.
 */
export const WIDEOKAMERY_PL_CAMERAS: CctvCamera[] = [
${rows.join('\n')}
];
`;

  fs.writeFileSync(OUT, body);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${rows.length} cameras)`);
}

(async () => {
  const harvested = fs.existsSync(HARVEST) && process.argv.includes('--from-cache')
    ? JSON.parse(fs.readFileSync(HARVEST, 'utf8'))
    : await harvest();
  emit(harvested);
})();
