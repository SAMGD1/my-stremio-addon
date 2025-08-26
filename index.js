'use strict';

/*  My Lists – IMDb → Stremio (stable)
 *  v11.2.0
 *  - Dedicated "my lists" type so catalogs don’t get mixed under Movie/Series
 *  - Robust IMDb discovery + full pagination for each list
 *  - Episode→Series upgrade (optional, on by default)
 *  - Metadata cascade: Cinemeta → OMDb (optional) → TMDb (optional) → IMDb JSON-LD/OG
 *  - One normalized timestamp for solid date sorting
 *  - Admin UI with drag & drop ordering, enable/disable, per-list default sort, default list
 *  - Saving bumps manifest (no reinstall)
 */

const express = require('express');

// -------- ENV --------
const PORT  = Number(process.env.PORT || 10000);
const HOST  = '0.0.0.0';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Stremio_172';
const SHARED_SECRET  = process.env.SHARED_SECRET  || '';

const IMDB_USER_URL     = process.env.IMDB_USER_URL || '';
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

// Optional accelerators (leave empty if you don’t have them)
const OMDB_API_KEY = process.env.OMDB_API_KEY || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

// Optional GitHub snapshot (safe to leave empty)
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || '';
const GITHUB_OWNER  = process.env.GITHUB_OWNER  || '';
const GITHUB_REPO   = process.env.GITHUB_REPO   || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const SNAPSHOT_PATH = (process.env.CSV_DIR || 'data') + '/snapshot.json';
const GH_ENABLED    = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/11.2';
const CINEMETA = 'https://v3-cinemeta.strem.io';

// -------- STATE --------
/** @type {Record<string,{id:string,name:string,url:string,ids:string[]}>} */
let LISTS = Object.create(null);

let PREFS = {
  enabled: [],           // which list ids are allowed; [] => all
  order: [],             // list id ordering
  defaultList: '',       // list id to open first (in Stremio’s “my lists”)
  perListSort: {},       // { lsid: "date_desc" | "name_asc" | ... }
  upgradeEpisodes: true  // map TVEpisode IDs to parent series
};

// caches
const BEST   = new Map(); // Map<tt, {kind:'movie'|'series', meta:object}>
const FALLBK = new Map(); // Map<tt, {name,poster,year,releaseDate,type}>
const CARD   = new Map(); // Map<tt, card>
const EP2SER = new Map(); // Map<ep_tt, series_tt>

// sync status
let LAST_SYNC_AT = 0;
let MANIFEST_REV = 1;
let syncBusy = false;
let syncTimer = null;
let LAST_MANIFEST_KEY = '';

// -------- UTILS --------
const isImdb = v => /^tt\d{7,}$/i.test(String(v||''));
const isList = v => /^ls\d{6,}$/i.test(String(v||''));
const ms = m => m * 60 * 1000;

async function fetchText(url, accept) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': accept || 'text/html,*/*' } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}
const withParam = (url, k, v) => { const u = new URL(url); u.searchParams.set(k, v); return u.toString(); };

// ---- GitHub (optional) ----
async function gh(method, path, body) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': UA
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error(`GitHub ${method} ${path} -> ${r.status} ${await r.text().catch(()=> '')}`);
  return r.json();
}
async function ghGetSha(path) {
  try {
    const j = await gh('GET', `/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    return j && j.sha;
  } catch { return null; }
}
async function ghWriteSnapshot(obj) {
  if (!GH_ENABLED) return;
  const content = Buffer.from(JSON.stringify(obj, null, 2)).toString('base64');
  const sha = await ghGetSha(SNAPSHOT_PATH);
  const body = { message: 'update snapshot.json', content, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  await gh('PUT', `/contents/${encodeURIComponent(SNAPSHOT_PATH)}`, body);
}
async function ghReadSnapshot() {
  if (!GH_ENABLED) return null;
  try {
    const j = await gh('GET', `/contents/${encodeURIComponent(SNAPSHOT_PATH)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
  } catch { return null; }
}

// ---- IMDb discovery ----
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(withParam(userListsUrl, '_', Date.now()), 'text/html');

  // find /list/ls##########/
  const re = /href="\/list\/(ls\d{6,})\/"/gi;
  const found = new Set();
  const results = [];

  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (!found.has(id)) {
      found.add(id);
      results.push({ id, url: `https://www.imdb.com/list/${id}/` });
    }
  }

  // fetch list names (small, fast)
  await Promise.all(results.map(async L => {
    try { L.name = await fetchListName(L.url); } catch { L.name = L.id; }
  }));

  return results;
}

async function fetchListName(listUrl) {
  const html = await fetchText(withParam(listUrl, '_', Date.now()), 'text/html');
  const tries = [
    /<h1[^>]+data-testid="list-header-title"[^>]*>(.*?)<\/h1>/i,
    /<h1[^>]*class="[^"]*header[^"]*"[^>]*>(.*?)<\/h1>/i,
    /<title>(.*?)<\/title>/i
  ];
  for (const rx of tries) {
    const m = html.match(rx);
    if (m) {
      const name = m[1].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
      if (name) return name;
    }
  }
  return listUrl;
}

function parseTconsts(html) {
  const out = [];
  const seen = new Set();

  let m;
  const re1 = /data-tconst="(tt\d{7,})"/gi;
  while ((m = re1.exec(html))) {
    const tt = m[1];
    if (!seen.has(tt)) { seen.add(tt); out.push(tt); }
  }
  const re2 = /\/title\/(tt\d{7,})\//gi;
  while ((m = re2.exec(html))) {
    const tt = m[1];
    if (!seen.has(tt)) { seen.add(tt); out.push(tt); }
  }
  return out;
}
function findNextPage(html) {
  let m = html.match(/<a[^>]+rel="next"[^>]+href="([^"]+)"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*lister-page-next[^"]*"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*data-testid="pagination-next-page-button"[^>]*>/i);
  if (!m) return null;
  try { return new URL(m[1], 'https://www.imdb.com').toString(); } catch { return null; }
}

async function fetchListItemsAllPages(listUrl, maxPages = 60) {
  const modes = ['detail', 'grid', 'compact']; // try several (some pages hide data-tconst)
  const seen = new Set();
  const ids = [];

  for (const mode of modes) {
    let pageUrl = withParam(listUrl, 'mode', mode);
    let pages = 0;
    while (pageUrl && pages < maxPages) {
      let html;
      try { html = await fetchText(withParam(pageUrl, '_', Date.now()), 'text/html'); }
      catch { break; }

      const found = parseTconsts(html);
      let added = 0;
      for (const tt of found) {
        if (!seen.has(tt)) { seen.add(tt); ids.push(tt); added++; }
      }
      pages++;
      const next = findNextPage(html);
      if (!next || added === 0) break;
      pageUrl = next;
    }
    if (ids.length) break; // one mode was enough
  }
  return ids;
}

// ---- Metadata helpers ----
async function fetchCinemeta(kind, imdbId) {
  try {
    const j = await fetchJson(`${CINEMETA}/meta/${kind}/${imdbId}.json`);
    return j && j.meta ? j.meta : null;
  } catch { return null; }
}
async function omdbById(imdbId) {
  if (!OMDB_API_KEY) return null;
  const u = `https://www.omdbapi.com/?apikey=${encodeURIComponent(OMDB_API_KEY)}&i=${encodeURIComponent(imdbId)}`;
  return fetchJson(u);
}
async function tmdbFindByImdb(imdbId) {
  if (!TMDB_API_KEY) return null;
  const u = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id`;
  return fetchJson(u);
}
async function imdbTitleJsonLd(imdbId) {
  try {
    const html = await fetchText(`https://www.imdb.com/title/${imdbId}/`, 'text/html');
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (m) {
      try { return JSON.parse(m[1]); } catch { /* ignore */ }
    }
    // OG fallback
    const t = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    const p = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    const d = html.match(/<meta[^>]+property="video:release_date"[^>]+content="([^"]+)"/i);
    return { name: t ? t[1] : undefined, image: p ? p[1] : undefined, datePublished: d ? d[1] : undefined };
  } catch { return null; }
}

// Try to map episode -> parent series
async function resolveEpisodeToSeries(imdbId) {
  if (EP2SER.has(imdbId)) return EP2SER.get(imdbId);
  const ld = await imdbTitleJsonLd(imdbId);
  let seriesId = null;
  try {
    const node = Array.isArray(ld && ld['@graph']) ? ld['@graph'].find(x => /TVEpisode/i.test(x['@type'])) : ld;
    const part = node && (node.partOfSeries || node.partOfTVSeries || (node.partOfSeason && node.partOfSeason.partOfSeries));
    const raw  = typeof part === 'string' ? part : (part && (part.url || part['@id'] || part.sameAs));
    const m = raw && String(raw).match(/tt\d{7,}/i);
    if (m) seriesId = m[0];
  } catch {}
  if (seriesId) EP2SER.set(imdbId, seriesId);
  return seriesId;
}

// One place to compute a reliable release timestamp
function toTs(dateStr, year) {
  if (dateStr) {
    const n = Date.parse(String(dateStr));
    if (!Number.isNaN(n)) return n;
  }
  if (year) {
    const n = Date.parse(`${year}-01-01`);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

async function getBestMeta(imdbId) {
  if (BEST.has(imdbId)) return BEST.get(imdbId);

  // 1) Cinemeta movie → series
  let meta = await fetchCinemeta('movie', imdbId);
  if (!meta) meta = await fetchCinemeta('series', imdbId);
  if (meta) {
    // normalize
    const kind = meta.type === 'series' ? 'series' : 'movie';
    const rel  = meta.releaseInfo || meta.released || meta.releaseDate || meta.premiere || undefined;
    const yr   = meta.year || (rel ? Number(String(rel).slice(0,4)) : undefined);
    const rec = { kind, meta: { ...meta, year: yr, released: rel } };
    BEST.set(imdbId, rec);
    return rec;
  }

  // 2) OMDb
  const om = await omdbById(imdbId).catch(()=>null);
  if (om && om.Response !== 'False') {
    const kind = om.Type === 'series' ? 'series' : 'movie';
    const year = om.Year ? Number(String(om.Year).slice(0,4)) : undefined;
    const released = (om.Released && om.Released !== 'N/A') ? om.Released : undefined;
    const poster = (om.Poster && om.Poster !== 'N/A') ? om.Poster : undefined;
    const rec = {
      kind,
      meta: {
        name: om.Title,
        poster,
        year,
        released,
        imdbRating: om.imdbRating ? Number(om.imdbRating) : undefined,
        runtime: om.Runtime ? Number(String(om.Runtime).replace(/\D+/g,'')) : undefined,
        description: om.Plot && om.Plot !== 'N/A' ? om.Plot : undefined
      }
    };
    BEST.set(imdbId, rec);
    return rec;
  }

  // 3) TMDb
  const t = await tmdbFindByImdb(imdbId).catch(()=>null);
  if (t && (t.movie_results?.length || t.tv_results?.length)) {
    const tv = t.tv_results?.[0];
    const mv = t.movie_results?.[0];
    const sel = tv || mv;
    const kind = tv ? 'series' : 'movie';
    const poster = sel.poster_path ? `https://image.tmdb.org/t/p/w500${sel.poster_path}` : undefined;
    const year = sel.release_date ? Number(sel.release_date.slice(0,4)) :
                 sel.first_air_date ? Number(sel.first_air_date.slice(0,4)) : undefined;
    const released = sel.release_date || sel.first_air_date || undefined;
    const rec = {
      kind,
      meta: {
        name: sel.name || sel.title,
        poster,
        year,
        released,
        description: sel.overview || undefined
      }
    };
    BEST.set(imdbId, rec);
    return rec;
  }

  // 4) IMDb JSON-LD / OG
  const ld = await imdbTitleJsonLd(imdbId);
  let name, poster, released, year, type = 'movie';
  try {
    const node = Array.isArray(ld && ld['@graph']) ? ld['@graph'].find(x => (x['@id']||'').includes(`/title/${imdbId}`)) || ld['@graph'][0] : ld;
    name = node?.name || node?.headline || ld?.name;
    poster = (typeof node?.image === 'string' ? node.image : node?.image?.url) || ld?.image;
    released = node?.datePublished || node?.startDate || node?.releaseDate || ld?.datePublished;
    year = released ? Number(String(released).slice(0,4)) : undefined;
    const ttype = Array.isArray(node?.['@type']) ? node['@type'][0] : node?.['@type'];
    if (/Series/i.test(ttype)) type = 'series';
  } catch {}

  const rec = { kind: type, meta: name ? { name, poster, year, released } : null };
  BEST.set(imdbId, rec);
  if (name || poster) FALLBK.set(imdbId, { name, poster, year, releaseDate: released, type });
  return rec;
}

function buildCard(imdbId) {
  const rec = BEST.get(imdbId) || { kind: 'movie', meta: null };
  const meta = rec.meta || {};
  const fb   = FALLBK.get(imdbId) || {};
  const name = meta.name || fb.name || imdbId;

  const year = meta.year ?? fb.year ?? undefined;
  const rel  = meta.released ?? meta.releaseInfo ?? fb.releaseDate ?? undefined;
  const ts   = toTs(rel, year);

  return {
    id: imdbId,
    type: rec.kind || fb.type || 'movie',
    name,
    poster: meta.poster || fb.poster || undefined,
    imdbRating: meta.imdbRating ?? undefined,
    runtime: meta.runtime ?? undefined,
    year,
    releaseDate: rel,
    _ts: ts, // internal, used for sorting (not exposed to Stremio)
    description: meta.description || undefined
  };
}

// stable manifest key
function manifestKey() {
  const enabled = (PREFS.enabled && PREFS.enabled.length) ? PREFS.enabled : Object.keys(LISTS);
  const names = enabled.map(id => LISTS[id]?.name || id).sort().join('|');
  return `${enabled.join(',')}#${PREFS.order.join(',')}#${PREFS.defaultList}#${names}`;
}

// ---- SYNC ----
async function fullSync({ rediscover = true } = {}) {
  if (syncBusy) return;
  syncBusy = true;
  try {
    let discovered = [];
    if (IMDB_USER_URL && rediscover) {
      try { discovered = await discoverListsFromUser(IMDB_USER_URL); }
      catch (e) { console.warn('IMDb discovery failed:', e.message); }
    }

    // build next lists map keeping old entries if IMDb hiccups
    const next = Object.create(null);
    const known = new Set(Object.keys(LISTS));

    for (const d of discovered) {
      next[d.id] = { id: d.id, name: d.name || d.id, url: d.url, ids: [] };
      known.delete(d.id);
    }
    for (const old of known) { // keep old lists (name + url), re-fetch items anyway
      next[old] = LISTS[old];
      if (next[old]) next[old].ids = [];
    }

    // fetch items per list
    const universe = new Set();
    for (const id of Object.keys(next)) {
      const url = next[id].url || `https://www.imdb.com/list/${id}/`;
      let ids = [];
      try { ids = await fetchListItemsAllPages(url); } catch {}
      next[id].ids = ids;
      for (const tt of ids) universe.add(tt);
    }

    // upgrade episodes → parent series when requested
    if (PREFS.upgradeEpisodes) {
      const remapCache = new Map();
      async function finalFor(tt) {
        if (remapCache.has(tt)) return remapCache.get(tt);
        // quick sniff from ld fallback (if we had it)
        if (FALLBK.get(tt)?.type === 'episode') {
          const ser = await resolveEpisodeToSeries(tt);
          remapCache.set(tt, ser || tt);
          return ser || tt;
        }
        // otherwise probe ld metadata cheaply
        const ld = await imdbTitleJsonLd(tt);
        let isEp = false;
        try {
          const node = Array.isArray(ld && ld['@graph']) ? ld['@graph'].find(x => /TVEpisode/i.test(x['@type'])) : ld;
          if (node && (node['@type'] === 'TVEpisode' || (Array.isArray(node['@type']) && node['@type'].includes('TVEpisode')))) isEp = true;
        } catch {}
        if (!isEp) { remapCache.set(tt, tt); return tt; }
        const ser = await resolveEpisodeToSeries(tt);
        remapCache.set(tt, ser || tt);
        return ser || tt;
      }

      // per-list
      for (const id of Object.keys(next)) {
        const seen = new Set();
        const arr = [];
        for (const tt of next[id].ids) {
          const final = await finalFor(tt);
          if (!seen.has(final)) { seen.add(final); arr.push(final); }
        }
        next[id].ids = arr;
      }

      // rebuild universe
      universe.clear();
      for (const id of Object.keys(next)) for (const tt of next[id].ids) universe.add(tt);
    }

    // preload metadata
    const all = Array.from(universe);
    for (const tt of all) { await getBestMeta(tt); CARD.set(tt, buildCard(tt)); }

    LISTS = next;
    LAST_SYNC_AT = Date.now();

    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) { LAST_MANIFEST_KEY = key; MANIFEST_REV++; }

    console.log(`[SYNC] ok – ${all.length} ids across ${Object.keys(LISTS).length} lists`);

    if (GH_ENABLED) {
      try {
        await ghWriteSnapshot({
          lastSyncAt: LAST_SYNC_AT,
          manifestRev: MANIFEST_REV,
          lists: LISTS,
          prefs: PREFS,
          fallback: Object.fromEntries(FALLBK),
          cards: Object.fromEntries(CARD),
          ep2ser: Object.fromEntries(EP2SER)
        });
      } catch (e) { console.warn('[SYNC] snapshot save failed:', e.message); }
    }

  } catch (e) {
    console.error('[SYNC] failed:', e);
  } finally {
    syncBusy = false;
  }
}

function scheduleSync(resetDelay) {
  if (syncTimer) clearTimeout(syncTimer);
  if (IMDB_SYNC_MINUTES <= 0) return;
  syncTimer = setTimeout(async () => {
    await fullSync({ rediscover: true });
    scheduleSync(true);
  }, ms(IMDB_SYNC_MINUTES));
}

async function bootFromSnapshot() {
  if (!GH_ENABLED) return false;
  const snap = await ghReadSnapshot();
  if (!snap) return false;
  try {
    LISTS = snap.lists || LISTS;
    PREFS = { ...PREFS, ...(snap.prefs || {}) };
    // soft restore
    FALLBK.clear(); if (snap.fallback) for (const [k,v] of Object.entries(snap.fallback)) FALLBK.set(k, v);
    CARD.clear();   if (snap.cards)    for (const [k,v] of Object.entries(snap.cards))    CARD.set(k, v);
    EP2SER.clear(); if (snap.ep2ser)   for (const [k,v] of Object.entries(snap.ep2ser))   EP2SER.set(k, v);
    MANIFEST_REV = snap.manifestRev || MANIFEST_REV;
    LAST_MANIFEST_KEY = manifestKey();
    console.log('[BOOT] snapshot loaded from GitHub');
    return true;
  } catch { return false; }
}

// -------- SERVER --------
const app = express();
app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
app.use(express.json());

const addonAllowed = req => {
  if (!SHARED_SECRET) return true;
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return u.searchParams.get('key') === SHARED_SECRET;
};
const adminAllowed = req => {
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return (u.searchParams.get('admin') || req.headers['x-admin-key']) === ADMIN_PASSWORD;
};
const absBase = req => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
};

app.get('/health', (_, res) => res.status(200).send('ok'));

// ---- Manifest (dedicated type: "my lists") ----
const baseManifest = {
  id: 'org.mylists.snapshot',
  version: '11.2.0',                  // keep 3-part semver; we’ll append rev in name
  name: 'My Lists',
  description: 'Your IMDb lists as instant catalogs.',
  resources: ['catalog','meta'],
  types: ['my lists'],                // << only this type so it shows up as its own tab
  idPrefixes: ['tt']
};

function enabledIds() {
  const discovered = Object.keys(LISTS);
  if (!PREFS.enabled || !PREFS.enabled.length) return discovered;
  const set = new Set(discovered);
  return PREFS.enabled.filter(id => set.has(id));
}
function catalogs() {
  const enabled = enabledIds();

  // order: use prefs.order for relative priority; else alphabetical by name
  const orderIndex = new Map(enabled.map((id, i) => [id, i + 1000]));
  (PREFS.order || []).forEach((id, idx) => { if (orderIndex.has(id)) orderIndex.set(id, idx); });

  const sorted = enabled.slice().sort((a,b) => {
    const ia = orderIndex.get(a) ?? 9999, ib = orderIndex.get(b) ?? 9999;
    if (ia !== ib) return ia - ib;
    const na = LISTS[a]?.name || a, nb = LISTS[b]?.name || b;
    return na.localeCompare(nb);
  });

  // per-list catalogs under "my lists"
  return sorted.map(lsid => ({
    type: 'my lists',
    id: `list:${lsid}`,
    name: `🗂 ${LISTS[lsid]?.name || lsid}`,
    extraSupported: ['search','skip','limit','sort'],
    extra: [
      { name:'search' }, { name:'skip' }, { name:'limit' },
      { name:'sort', options:['date_asc','date_desc','rating_asc','rating_desc','runtime_asc','runtime_desc','name_asc','name_desc'] }
    ],
    posterShape: 'poster'
  }));
}

app.get('/manifest.json', (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send('Forbidden');
    res.setHeader('Cache-Control', 'no-store');
    const cats = catalogs();
    // keep semver three-part; show rev in name (avoid Stremio colon error)
    const name = baseManifest.name + ` • rev ${MANIFEST_REV}`;
    res.json({ ...baseManifest, name, catalogs: cats });
  } catch (e) {
    console.error('manifest:', e);
    res.status(500).send('Internal Server Error');
  }
});

// ---- Helpers ----
function parseExtra(extraStr, queryObj) {
  const params = new URLSearchParams(extraStr || '');
  return { ...Object.fromEntries(params.entries()), ...(queryObj || {}) };
}
function cmpNullBottom(a, b) {
  const na = (a == null), nb = (b == null);
  if (na && nb) return 0;
  if (na) return 1;
  if (nb) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}
function sortMetas(arr, key) {
  const s = String(key || 'name_asc').toLowerCase();
  const dir = s.endsWith('_asc') ? 1 : -1;
  const field = s.split('_')[0];

  return arr
    .map((m, i) => ({ m, i }))
    .sort((A, B) => {
      const a = A.m, b = B.m;
      let c = 0;
      if (field === 'date') c = cmpNullBottom(a._ts ?? null, b._ts ?? null);
      else if (field === 'rating') c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
      else if (field === 'runtime') c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
      else c = (a.name || '').localeCompare(b.name || '');
      if (c === 0) {
        c = (a.name || '').localeCompare(b.name || '');
        if (c === 0) c = (a.id || '').localeCompare(b.id || '');
        if (c === 0) c = A.i - B.i;
      }
      return c * dir;
    })
    .map(x => x.m);
}

// ---- Catalog ----
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send('Forbidden');
    res.setHeader('Cache-Control', 'no-store');

    const { id } = req.params; // id like "list:ls4107..."
    if (!id || !id.startsWith('list:')) return res.json({ metas: [] });

    const lsid = id.slice(5);
    const list = LISTS[lsid];
    if (!list) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q     = String(extra.search || '').toLowerCase().trim();
    const sort  = (extra.sort || PREFS.perListSort?.[lsid] || 'name_asc').toLowerCase();
    const skip  = Math.max(0, Number(extra.skip || 0));
    const limit = Math.min(Number(extra.limit || 100), 200);

    let metas = (list.ids || []).map(tt => CARD.get(tt) || buildCard(tt));

    if (q) {
      metas = metas.filter(m =>
        (m.name || '').toLowerCase().includes(q) ||
        (m.id || '').toLowerCase().includes(q) ||
        (m.description || '').toLowerCase().includes(q)
      );
    }

    metas = sortMetas(metas, sort);
    const page = metas.slice(skip, skip + limit).map(({ _ts, ...x }) => x); // strip _ts
    res.json({ metas: page });
  } catch (e) {
    console.error('catalog:', e);
    res.status(500).send('Internal Server Error');
  }
});

// ---- Meta ----
app.get('/meta/:type/:id.json', async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send('Forbidden');
    res.setHeader('Cache-Control', 'no-store');

    const imdbId = req.params.id;
    if (!isImdb(imdbId)) return res.json({ meta: { id: imdbId, type: 'movie', name: 'Unknown item' } });

    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);

    if (!rec || !rec.meta) {
      const fb = FALLBK.get(imdbId) || {};
      return res.json({ meta: { id: imdbId, type: rec?.kind || fb.type || 'movie', name: fb.name || imdbId, poster: fb.poster || undefined } });
    }
    const base = buildCard(imdbId);
    const { _ts, ...clean } = base;
    return res.json({ meta: clean });
  } catch (e) {
    console.error('meta:', e);
    res.status(500).send('Internal Server Error');
  }
});

// ---- Admin (drag & drop) ----
app.get('/admin', async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send('Forbidden. Append ?admin=YOUR_PASSWORD');

  const base = absBase(req);
  const manifestUrl = `${base}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ''}`;

  let discovered = [];
  let dbg = '';
  try {
    if (IMDB_USER_URL) {
      const html = await fetchText(withParam(IMDB_USER_URL, '_', Date.now()), 'text/html');
      dbg = html.slice(0, 600).replace(/[<>]/g, s => ({'<':'&lt;','>':'&gt;'}[s]));
      discovered = await discoverListsFromUser(IMDB_USER_URL);
    }
  } catch {}

  const rows = Object.keys(LISTS).map(id => {
    const L = LISTS[id]; const count = (L.ids || []).length;
    return `<li><b>${L.name || id}</b> <small>(${count} items)</small><br><small>${L.url}</small></li>`;
  }).join('') || '<li>(none)</li>';

  const disc = discovered.map(d => `<li><b>${d.name || d.id}</b><br><small>${d.url}</small></li>`).join('') || '<li>(none found or IMDb unreachable right now).</li>';

  res.type('html').send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Admin</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:960px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
button{padding:10px 16px;border:0;border-radius:8px;background:#6c5ce7;color:#fff;cursor:pointer}
.btn2{background:#2d6cdf}
small{color:#666}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}
table{width:100%;border-collapse:collapse}
th,td{padding:8px;border-bottom:1px solid #eee;text-align:left}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
ul{margin:6px 0 0 18px}
.drag{cursor:grab}
.dragging{opacity:.6}
.badge{display:inline-block;background:#eee;border-radius:999px;padding:2px 8px;font-size:12px;margin-left:6px}
</style>
</head>
<body>
<h1>My Lists – Admin</h1>

<div class="card">
  <h3>Current Snapshot</h3>
  <ul>${rows}</ul>
  <p><small>Last sync: ${LAST_SYNC_AT ? new Date(LAST_SYNC_AT).toLocaleString() + " (" + Math.round((Date.now()-LAST_SYNC_AT)/60000) + " min ago)" : "never"}</small></p>
  <div class="row">
    <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}">
      <button class="btn2">Sync IMDb Lists Now</button>
    </form>
    <span class="badge">Auto-sync every ${IMDB_SYNC_MINUTES} min${IMDB_SYNC_MINUTES ? "" : " (disabled)"}.</span>
  </div>
</div>

<div class="card">
  <h3>Customize (enable/disable, order, defaults)</h3>
  <p><small>
    Drag the rows to change order. The first enabled list becomes the default unless you pick one below.
    "Upgrade episodes" maps TV episode items to their parent series to avoid duplicate/fragmented entries.
  </small></p>
  <div id="ui"></div>
  <div class="row" style="margin-top:10px">
    <button id="saveBtn">Save</button>
    <span id="msg" style="color:#2d6cdf"></span>
  </div>
</div>

<div class="card">
  <h3>Discovered at <span class="code">${IMDB_USER_URL || '(IMDB_USER_URL not set)'}</span></h3>
  <ul>${disc}</ul>
  <p><small>Debug: <a href="data:text/html;charset=utf-8,${dbg}">open</a> (shows first part of HTML we receive)</small></p>
</div>

<div class="card">
  <h3>Manifest URL</h3>
  <p class="code">${manifestUrl}</p>
  <p><small>Version bumps automatically when catalogs change.</small></p>
</div>

<script>
const admin = ${JSON.stringify(ADMIN_PASSWORD)};
async function j(url, opt){ const r = await fetch(url, opt); if(!r.ok) throw new Error(await r.text()); return r.json().catch(()=> ({})); }

async function load() {
  const lists = await j('/api/lists?admin='+admin);
  const prefs = await j('/api/prefs?admin='+admin);
  const container = document.getElementById('ui');
  container.innerHTML = '';

  const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));
  const order = prefs.order && prefs.order.length ? prefs.order.slice() : Object.keys(lists);

  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Enabled</th><th>List (name)</th><th>Items</th><th>Default sort</th></tr></thead>';
  const tbody = document.createElement('tbody'); table.appendChild(tbody);

  function rowFor(lsid) {
    const L = lists[lsid]; const tr = document.createElement('tr'); tr.className='drag'; tr.draggable = true; tr.dataset.id = lsid;
    const cb = document.createElement('input'); cb.type='checkbox'; cb.checked = enabledSet.has(lsid);
    cb.onchange = () => { if (cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); };

    const td0 = document.createElement('td'); td0.appendChild(cb);
    const td1 = document.createElement('td'); td1.innerHTML = '<b>'+ (L.name||lsid) + '</b><br><small>'+lsid+'</small>';
    const td2 = document.createElement('td'); td2.textContent = String((L.ids||[]).length);

    const td3 = document.createElement('td');
    const sel = document.createElement('select');
    const opts = ['date_asc','date_desc','rating_asc','rating_desc','runtime_asc','runtime_desc','name_asc','name_desc'];
    const def = (prefs.perListSort && prefs.perListSort[lsid]) || 'name_asc';
    for (const o of opts) { const op = document.createElement('option'); op.value=o; op.text=o; if (o===def) op.selected=true; sel.appendChild(op); }
    sel.onchange = () => { prefs.perListSort = prefs.perListSort || {}; prefs.perListSort[lsid] = sel.value; };
    td3.appendChild(sel);

    tr.appendChild(td0); tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
    return tr;
  }

  order.forEach(id => tbody.appendChild(rowFor(id)));
  table.appendChild(tbody);
  container.appendChild(table);

  // drag & drop
  let dragEl = null;
  tbody.addEventListener('dragstart', e => { const tr = e.target.closest('tr'); if(!tr) return; dragEl = tr; tr.classList.add('dragging'); });
  tbody.addEventListener('dragend', e => { const tr = e.target.closest('tr'); if(tr) tr.classList.remove('dragging'); dragEl = null; });
  tbody.addEventListener('dragover', e => {
    e.preventDefault();
    const after = [...tbody.querySelectorAll('tr:not(.dragging)')].find(r => e.clientY <= r.getBoundingClientRect().top + r.offsetHeight/2);
    if (!dragEl) return;
    if (after) tbody.insertBefore(dragEl, after); else tbody.appendChild(dragEl);
  });

  // default list + upgrade episodes
  const ctl = document.createElement('div'); ctl.style.margin='10px 0';
  ctl.innerHTML = '<b>Default list:</b> ';
  const defSel = document.createElement('select');
  for (const id of order) {
    const opt = document.createElement('option');
    opt.value = id; opt.text = (lists[id].name||id);
    if (id === (prefs.defaultList || order[0])) opt.selected = true;
    defSel.appendChild(opt);
  }
  ctl.appendChild(defSel);
  ctl.appendChild(document.createTextNode('  '));
  const ep = document.createElement('input'); ep.type='checkbox'; ep.checked = !!prefs.upgradeEpisodes;
  ctl.appendChild(ep); ctl.appendChild(document.createTextNode(' Upgrade episodes to parent series'));
  container.insertBefore(ctl, table);

  // save
  document.getElementById('saveBtn').onclick = async () => {
    const rows = [...tbody.querySelectorAll('tr')];
    const newOrder = rows.map(r => r.dataset.id);
    const enabled = [...enabledSet];
    const body = {
      enabled,
      order: newOrder,
      defaultList: defSel.value || (newOrder[0] || ''),
      perListSort: prefs.perListSort || {},
      upgradeEpisodes: ep.checked
    };
    const r = await fetch('/api/prefs?admin='+admin, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const t = await r.text();
    document.getElementById('msg').textContent = t || 'Saved.';
    setTimeout(()=> document.getElementById('msg').textContent = '', 2200);
  };
}
load();
</script>
</body></html>`);
});

// Admin APIs
app.get('/api/lists', (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send('Forbidden');
  res.json(LISTS);
});
app.get('/api/prefs', (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send('Forbidden');
  res.json(PREFS);
});
app.post('/api/prefs', async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send('Forbidden');
  try {
    const b = req.body || {};
    PREFS.enabled         = Array.isArray(b.enabled) ? b.enabled.filter(isList) : [];
    PREFS.order           = Array.isArray(b.order)   ? b.order.filter(isList)   : [];
    PREFS.defaultList     = isList(b.defaultList) ? b.defaultList : '';
    PREFS.perListSort     = (b.perListSort && typeof b.perListSort==='object') ? b.perListSort : {};
    PREFS.upgradeEpisodes = !!b.upgradeEpisodes;

    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) { LAST_MANIFEST_KEY = key; MANIFEST_REV++; }

    if (GH_ENABLED) {
      try {
        await ghWriteSnapshot({
          lastSyncAt: LAST_SYNC_AT,
          manifestRev: MANIFEST_REV,
          lists: LISTS,
          prefs: PREFS,
          fallback: Object.fromEntries(FALLBK),
          cards: Object.fromEntries(CARD),
          ep2ser: Object.fromEntries(EP2SER)
        });
      } catch {}
    }

    res.status(200).send('Saved. Manifest rev ' + MANIFEST_REV);
  } catch (e) {
    console.error('prefs:', e);
    res.status(500).send('Failed to save');
  }
});
app.post('/api/sync', async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send('Forbidden');
  try {
    await fullSync({ rediscover: true });
    scheduleSync(true);
    res.status(200).send(`Synced at ${new Date().toISOString()} • <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// ---- BOOT ----
(async () => {
  await bootFromSnapshot();
  fullSync({ rediscover: true }).then(()=> scheduleSync(false));
  app.listen(PORT, HOST, () => {
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ''}`);
  });
})();
