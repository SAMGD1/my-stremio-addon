/*  My Lists (IMDb → Stremio) – robust, cached, auto-sync
 *  - Discovers lists from IMDB_USER_URL and merges with IMDB_LISTS
 *  - Robust list scraping: tries mode=detail/grid/compact, paginates via next links
 *  - Preloads Cinemeta (movie → series), uses cached cards for instant catalogs
 *  - Force sync: /api/sync-imdb   Admin UI: /admin?admin=PASSWORD
 */

const express = require("express");

// -------- ENV --------
const PORT = Number(process.env.PORT) || 7000;
const HOST = "0.0.0.0";

const SHARED_SECRET  = process.env.SHARED_SECRET  || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_LISTS_JSON   = process.env.IMDB_LISTS || "[]";   // optional whitelist: [{ "name": "Marvel Movies", "url": "https://www.imdb.com/list/ls..." }]
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

const CINEMETA = "https://v3-cinemeta.strem.io";

// -------- RUNTIME STATE --------
// { [listName]: { url, ids: string[] } }
let LISTS = Object.create(null);
// Best Cinemeta per tt: Map<tt, {kind:'movie'|'series'|null, meta:object|null}>
const BEST = new Map();
// Prebuilt catalog cards: Map<tt, { id, type, name, poster, ... }>
const CARDS = new Map();

let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;
let MANIFEST_REV = 1;

// -------- HELPERS --------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116 Safari/537.36";
function headersHTML(referer) {
  const h = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
  };
  if (referer) h.Referer = referer;
  return h;
}
async function fetchText(url, referer) {
  const u = new URL(url);
  // Bust CDN caches a little
  u.searchParams.set("_", Date.now().toString());
  const r = await fetch(u.toString(), { headers: headersHTML(referer) });
  if (!r.ok) throw new Error(`GET ${u} -> ${r.status}`);
  return r.text();
}
function isImdb(v) { return /^tt\d{7,}$/i.test(String(v || "")); }
function nowIso() { return new Date().toISOString(); }
function minutes(ms) { return Math.round(ms / 60000); }

// -------- DISCOVERY (lists) --------
function parseImdbListsEnv() {
  try {
    const arr = JSON.parse(IMDB_LISTS_JSON);
    if (Array.isArray(arr)) {
      return arr
        .map(x => ({ name: String(x.name || "").trim(), url: String(x.url || "").trim() }))
        .filter(x => x.name && x.url.includes("/list/ls"));
    }
  } catch (_) {}
  return [];
}
function listIdFromUrl(url) {
  try {
    const m = String(url).match(/\/list\/(ls\d{6,})\//i);
    return m ? m[1] : null;
  } catch { return null; }
}
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  let html;
  try {
    html = await fetchText(userListsUrl);
  } catch {
    return [];
  }
  // Match links to /list/ls##########/ and their titles
  // (avoid noisy sidebar links by restricting to anchors)
  const re = /<a[^>]+href="\/list\/(ls\d{6,})\/"[^>]*>(.*?)<\/a>/gi;
  const map = new Map();
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const name = String(m[2] || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (id && name && !map.has(id)) {
      map.set(id, { name, url: `https://www.imdb.com/list/${id}/` });
    }
  }
  return Array.from(map.values());
}
function mergeListConfigs(envLists, discovered) {
  const byId = new Map();
  for (const L of [...envLists, ...discovered]) {
    const id = listIdFromUrl(L.url);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, { name: L.name, url: L.url });
    // Prefer the lexicographically longer name (often the “real” list title)
    else if ((L.name || "").length > (byId.get(id).name || "").length) {
      byId.set(id, { name: L.name, url: L.url });
    }
  }
  return Array.from(byId.values());
}

// -------- LIST PARSER (robust) --------
function extractIdsFromHtml(html) {
  const out = new Set();
  let m;

  // 1) data-tconst (grid/new UI)
  const re1 = /data-tconst="(tt\d{7,})"/gi;
  while ((m = re1.exec(html))) out.add(m[1]);

  // 2) classic /title/tt#########/
  const re2 = /\/title\/(tt\d{7,})\//gi;
  while ((m = re2.exec(html))) out.add(m[1]);

  // 3) JSON blobs sometimes contain "const":"tt#########"
  const re3 = /"const"\s*:\s*"(tt\d{7,})"/gi;
  while ((m = re3.exec(html))) out.add(m[1]);

  return Array.from(out);
}
function findNextUrl(html, currentUrl) {
  // Look for various "next" anchors used across old/new layouts
  let m = html.match(/<a[^>]+rel="next"[^>]+href="([^"]+)"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*lister-page-next[^"]*"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*data-testid="pagination-next-page-button"[^>]*>/i);
  if (!m) return null;
  try { return new URL(m[1], new URL(currentUrl).origin).toString(); } catch { return null; }
}
async function fetchImdbListIdsAllPages(listUrl) {
  const modes = ["detail", "grid", "compact"];
  const seen = new Set();
  const all = [];

  for (const mode of modes) {
    let url = new URL(listUrl);
    url.searchParams.set("mode", mode);

    // Some lists also paginate by ?page=2, but the “next” link is more reliable.
    let guard = 0;
    while (url && guard++ < 50) {
      let html;
      try { html = await fetchText(url.toString(), listUrl); }
      catch { break; }

      const ids = extractIdsFromHtml(html);
      let added = 0;
      for (const tt of ids) {
        if (!seen.has(tt)) {
          seen.add(tt);
          all.push(tt);
          added++;
        }
      }

      const nextUrl = findNextUrl(html, url.toString());
      if (!nextUrl || added === 0) break;
      url = new URL(nextUrl);
    }
    if (all.length) break; // success with this mode
  }

  return all;
}

// -------- CINEMETA --------
async function fetchCinemeta(kind, imdbId) {
  try {
    const r = await fetch(`${CINEMETA}/meta/${encodeURIComponent(kind)}/${encodeURIComponent(imdbId)}.json`, {
      headers: { "User-Agent": UA, "Accept": "application/json" }
    });
    if (!r.ok) return null;
    const obj = await r.json();
    return obj && obj.meta ? obj.meta : null;
  } catch { return null; }
}
async function getBestMeta(imdbId) {
  if (BEST.has(imdbId)) return BEST.get(imdbId);
  let meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind: "movie", meta }; BEST.set(imdbId, rec); return rec; }
  meta = await fetchCinemeta("series", imdbId);
  if (meta) { const rec = { kind: "series", meta }; BEST.set(imdbId, rec); return rec; }
  const rec = { kind: null, meta: null };
  BEST.set(imdbId, rec);
  return rec;
}
async function mapLimit(arr, limit, fn) {
  const results = new Array(arr.length);
  let i = 0;
  const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (i < arr.length) {
      const idx = i++;
      results[idx] = await fn(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// Build cached card for catalogs
function buildCard(tt) {
  const rec = BEST.get(tt) || { kind: null, meta: null };
  const meta = rec.meta;

  const card = {
    id: tt,
    type: rec.kind || "movie",
    name: (meta && meta.name) ? meta.name : tt
  };

  if (meta) {
    if (typeof meta.poster === "string") card.poster = meta.poster;
    if (typeof meta.background === "string") card.background = meta.background;
    if (typeof meta.logo === "string") card.logo = meta.logo;

    const rating = (meta.imdbRating !== undefined) ? meta.imdbRating : (meta.rating !== undefined ? meta.rating : null);
    if (rating !== null) card.imdbRating = rating;

    if (meta.runtime !== undefined) card.runtime = meta.runtime;
    if (meta.year !== undefined) card.year = meta.year;

    const released = (meta.releaseInfo !== undefined) ? meta.releaseInfo : (meta.released !== undefined ? meta.released : null);
    if (released !== null) card.releaseDate = released;

    if (typeof meta.description === "string") card.description = meta.description;
  }

  return card;
}

// -------- SORTING --------
function toTs(dateStr, year) {
  if (dateStr) {
    const t = Date.parse(dateStr);
    if (!Number.isNaN(t)) return t;
  }
  if (year) {
    const t = Date.parse(String(year) + "-01-01");
    if (!Number.isNaN(t)) return t;
  }
  return null;
}
function stableSort(items, sortKey) {
  const s = String(sortKey || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const key = s.split("_")[0];

  function cmpNullBottom(a, b) {
    const A = (a === null || a === undefined);
    const B = (b === null || b === undefined);
    if (A && B) return 0;
    if (A) return 1;
    if (B) return -1;
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  return items
    .map((m, i) => ({ m, i }))
    .sort((A, B) => {
      const a = A.m, b = B.m;
      let c = 0;

      if (key === "date")       c = cmpNullBottom(toTs(a.releaseDate, a.year), toTs(b.releaseDate, b.year));
      else if (key === "rating")  c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
      else if (key === "runtime") c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
      else                        c = (a.name || "").localeCompare(b.name || "");

      if (c === 0) {
        c = (a.name || "").localeCompare(b.name || "");
        if (c === 0) c = (a.id || "").localeCompare(b.id || "");
        if (c === 0) c = A.i - B.i;
      }
      return c * dir;
    })
    .map(x => x.m);
}

// -------- FULL SYNC --------
async function fullSync({ rediscover = true } = {}) {
  if (syncInProgress) return;
  syncInProgress = true;
  const started = Date.now();

  try {
    // 1) lists source = merge(IMDB_LISTS, discover(IMDB_USER_URL))
    const envLists = parseImdbListsEnv();
    let discovered = [];
    if (rediscover && IMDB_USER_URL) {
      try { discovered = await discoverListsFromUser(IMDB_USER_URL); }
      catch { discovered = []; }
    }
    const cfg = mergeListConfigs(envLists, discovered);

    // 2) fetch ids for each list
    const nextLISTS = Object.create(null);
    const allIds = new Set();
    for (const L of cfg) {
      let ids = [];
      try { ids = await fetchImdbListIdsAllPages(L.url); }
      catch { ids = []; }
      nextLISTS[L.name] = { url: L.url, ids };
      ids.forEach(id => allIds.add(id));
    }
    LISTS = nextLISTS;

    // 3) preload Cinemeta & build cards
    const idsArr = Array.from(allIds);
    await mapLimit(idsArr, 8, async (tt) => { if (isImdb(tt)) await getBestMeta(tt); });
    CARDS.clear();
    idsArr.forEach(tt => CARDS.set(tt, buildCard(tt)));

    // 4) bump manifest if list names changed
    MANIFEST_REV++;

    LAST_SYNC_AT = Date.now();
    console.log(`[SYNC] ok – ${idsArr.length} ids across ${Object.keys(LISTS).length} lists in ${minutes(LAST_SYNC_AT - started)} min`);
  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    syncInProgress = false;
  }
}
function scheduleNextSync(reset = false) {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  if (IMDB_SYNC_MINUTES <= 0) return;
  const delayMs = IMDB_SYNC_MINUTES * 60 * 1000;
  syncTimer = setTimeout(async () => {
    await fullSync({ rediscover: true });
    scheduleNextSync(true);
  }, reset ? delayMs : delayMs);
}

// Kick initial sync
fullSync({ rediscover: true }).then(() => scheduleNextSync(false));

function maybeBackgroundSync() {
  if (IMDB_SYNC_MINUTES <= 0) return;
  const stale = Date.now() - LAST_SYNC_AT > IMDB_SYNC_MINUTES * 60 * 1000;
  if (stale && !syncInProgress) fullSync({ rediscover: true }).then(() => scheduleNextSync(true));
}

// -------- HTTP --------
const app = express();
app.use((_, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });

function addonAllowed(req) {
  if (!SHARED_SECRET) return true;
  const url = new URL(req.originalUrl, `http://${req.headers.host}`);
  return url.searchParams.get("key") === SHARED_SECRET;
}
function adminAllowed(req) {
  const url = new URL(req.originalUrl, `http://${req.headers.host}`);
  return (url.searchParams.get("admin") || req.headers["x-admin-key"]) === ADMIN_PASSWORD;
}
function absoluteBase(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

app.get("/health", (_, res) => res.status(200).send("ok"));

// Manifest with auto-rev bump so Stremio refreshes catalogs
const baseManifest = {
  id: "org.my.csvlists",
  version: "9.2.0",
  name: "My Lists",
  description: "Your IMDb lists as instant catalogs (preloaded)",
  resources: ["catalog", "meta"],
  types: ["my lists", "movie", "series"],
  idPrefixes: ["tt"]
};
function catalogs() {
  return Object.keys(LISTS).map((name) => ({
    type: "My lists",
    id: `list:${name}`,
    name: `🗂 ${name}`,
    extraSupported: ["search", "skip", "limit", "sort"],
    extra: [
      { name: "search" }, { name: "skip" }, { name: "limit" },
      { name: "sort", options: ["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"] }
    ],
    posterShape: "poster"
  }));
}
app.get("/manifest.json", (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    const version = `${baseManifest.version}.${MANIFEST_REV}`;
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...baseManifest, version, catalogs: catalogs() });
  } catch (e) {
    console.error("Manifest error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Catalog (all from CARDS cache)
function parseExtra(extraStr, queryObj) {
  const params = new URLSearchParams(extraStr || "");
  return { ...Object.fromEntries(params.entries()), ...(queryObj || {}) };
}
app.get("/catalog/:type/:id/:extra?.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const { id } = req.params;
    if (!id || !id.startsWith("list:")) return res.json({ metas: [] });
    const listName = id.slice(5);
    const list = LISTS[listName];
    if (!list || !list.ids || !list.ids.length) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q = String(extra.search || "").toLowerCase().trim();
    const sort = String(extra.sort || "name_asc").toLowerCase();
    const skip = Math.max(0, Number(extra.skip || 0));
    const limit = Math.min(Number(extra.limit || 100), 200);

    let metas = list.ids.map(tt => CARDS.get(tt) || { id: tt, type: "movie", name: tt });

    if (q) {
      metas = metas.filter(m =>
        (m.name || "").toLowerCase().includes(q) ||
        (m.id || "").toLowerCase().includes(q) ||
        (m.description || "").toLowerCase().includes(q)
      );
    }

    metas = stableSort(metas, sort);
    res.json({ metas: metas.slice(skip, skip + limit) });
  } catch (e) {
    console.error("Catalog error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Meta (serve preloaded Cinemeta; fetch on demand if missing)
app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const imdbId = req.params.id;
    if (!isImdb(imdbId))
      return res.json({ meta: { id: imdbId, type: "movie", name: "Unknown item" } });

    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);
    if (!rec || !rec.meta)
      return res.json({ meta: { id: imdbId, type: rec && rec.kind ? rec.kind : "movie", name: imdbId } });

    return res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
  } catch (e) {
    console.error("Meta error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Admin
app.get("/admin", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");

  let discovered = [];
  try { if (IMDB_USER_URL) discovered = await discoverListsFromUser(IMDB_USER_URL); }
  catch { discovered = []; }

  const manifestUrl = `${absoluteBase(req)}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;
  const uiLists = Object.entries(LISTS)
    .map(([name, v]) => `<li><b>${name}</b> <small>(${(v.ids||[]).length} items)</small><br/><small>${v.url || ""}</small></li>`)
    .join("") || "<li>(none)</li>";

  const discLists = discovered.length
    ? `<ul>${discovered.map(x => `<li><b>${x.name}</b><br/><small>${x.url}</small></li>`).join("")}</ul>`
    : `<p><small>${IMDB_USER_URL ? "No public lists found (or IMDb unreachable right now)." : "Set IMDB_USER_URL or IMDB_LISTS in your environment."}</small></p>`;

  res.type("html").send(`<!doctype html>
<html>
<head>
  <title>My Lists – Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:760px}
    .card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
    button{padding:10px 16px;border:0;border-radius:8px;background:#6c5ce7;color:#fff;cursor:pointer}
    small{color:#666}
    .code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}
    .btn2{background:#2d6cdf}
  </style>
</head>
<body>
  <h1>My Lists – Admin</h1>

  <div class="card">
    <h3>Current Snapshot</h3>
    <ul>${uiLists}</ul>
    <p><small>Last sync: ${LAST_SYNC_AT ? new Date(LAST_SYNC_AT).toLocaleString() + " (" + minutes(Date.now()-LAST_SYNC_AT) + " min ago)" : "never"}</small></p>
    <form method="POST" action="/api/sync-imdb?admin=${ADMIN_PASSWORD}">
      <button class="btn2">Sync IMDb Lists Now</button>
    </form>
    <p><small>Auto-sync every ${IMDB_SYNC_MINUTES} min.</small></p>
  </div>

  <div class="card">
    <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
    ${discLists}
  </div>

  <div class="card">
    <h3>Manifest URL</h3>
    <p class="code">${manifestUrl}</p>
  </div>
</body>
</html>`);
});

app.post("/api/sync-imdb", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    await fullSync({ rediscover: true });
    scheduleNextSync(true);
    res.status(200).send(`Synced at ${nowIso()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

// Start
app.listen(PORT, HOST, () => {
  console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
});
