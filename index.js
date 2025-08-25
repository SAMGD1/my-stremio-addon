// My Lists (IMDb-only) Stremio add-on with cached snapshot + auto/force sync
// - Discovers all public lists from IMDB_USER_URL, or uses IMDB_LISTS whitelist
// - Preloads Cinemeta for every tt id (movie -> series), caches best hit
// - Catalogs/meta read from cache (fast, stable)
// - Auto sync every IMDB_SYNC_MINUTES; "Sync now" re-discovers + resets timer

const express = require("express");

// ---- env ----
const PORT = Number(process.env.PORT) || 7000;
const HOST = "0.0.0.0";

const SHARED_SECRET  = process.env.SHARED_SECRET  || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_LISTS_JSON   = process.env.IMDB_LISTS || "[]";  // optional whitelist: [{name,url}]
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

const CINEMETA = "https://v3-cinemeta.strem.io";

// ---- state ----
/** { [listName]: { url, ids: string[] } } */
let LISTS = {};
/** best meta per imdb id: Map<tt, { kind:'movie'|'series'|null, meta:object|null }> */
const BEST = new Map();
/** last successful full sync timestamp (ms) */
let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;

// ---- tiny helpers ----
const isImdb = (v) => /^tt\d{7,}$/i.test(String(v || ""));
async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html,*/*" } });
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return r.text();
}
function nowIso() { return new Date().toISOString(); }
function minutes(ms) { return Math.round(ms / 60000); }

// ---- IMDb list discovery / parsing ----
function parseImdbListsEnv() {
  try { const arr = JSON.parse(IMDB_LISTS_JSON); return Array.isArray(arr) ? arr.filter(x => x && x.name && x.url) : []; }
  catch { return []; }
}
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(userListsUrl);
  // anchors like: href="/list/ls##########/" ... >List Title<
  const re = /href="\/list\/(ls\d{6,})\/[^"]*".*?>([^<]+)</gi;
  const found = new Map();
  let m;
  while ((m = re.exec(html))) {
    const id = m[1], name = m[2].trim();
    found.set(id, { name, url: `https://www.imdb.com/list/${id}/` });
  }
  return Array.from(found.values());
}
function tconstsFromHtml(html) {
  // Prefer data-tconst, fall back to /title/tt#######/
  const out = []; const seen = new Set();
  let m;
  const re1 = /data-tconst="(tt\d{7,})"/gi;
  while ((m = re1.exec(html))) { const tt = m[1]; if (!seen.has(tt)) { seen.add(tt); out.push(tt); } }
  const re2 = /\/title\/(tt\d{7,})/gi;
  while ((m = re2.exec(html))) { const tt = m[1]; if (!seen.has(tt)) { seen.add(tt); out.push(tt); } }
  return out;
}
async function fetchImdbListIdsAllPages(listUrl, maxPages = 25) {
  const base = new URL(listUrl);
  const all = []; const seen = new Set();
  for (let p = 1; p <= maxPages; p++) {
    base.searchParams.set("page", String(p));
    let html;
    try { html = await fetchText(base.toString()); } catch { break; }
    const ids = tconstsFromHtml(html);
    let added = 0;
    for (const tt of ids) if (!seen.has(tt)) { seen.add(tt); all.push(tt); added++; }
    if (ids.length === 0 || added === 0) break; // end
  }
  return all;
}

// ---- Cinemeta (try movie then series) ----
async function fetchCinemeta(kind, imdbId) {
  try {
    const r = await fetch(`${CINEMETA}/meta/${encodeURIComponent(kind)}/${encodeURIComponent(imdbId)}.json`);
    if (!r.ok) return null;
    const { meta } = await r.json();
    return meta || null;
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

// simple concurrency control for preloading many metas
async function mapLimit(arr, limit, fn) {
  const results = new Array(arr.length);
  let i = 0;
  const runners = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (i < arr.length) {
      const idx = i++;
      results[idx] = await fn(arr[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---- build cache snapshot from BEST + LISTS ----
function snapshotForId(tt) {
  const rec = BEST.get(tt) || { kind: null, meta: null };
  const meta = rec.meta;
  const snap = {
    id: tt,
    type: rec.kind || "movie",
    name: (meta && meta.name) ? meta.name : tt, // guarantee a name so tiles aren't blank
  };
  if (meta) {
    snap.poster = meta.poster || undefined;
    snap.background = meta.background || undefined;
    snap.logo = meta.logo || undefined;
    snap.imdbRating = meta.imdbRating ?? meta.rating ?? undefined;
    snap.runtime = meta.runtime ?? undefined;
    snap.year = meta.year ?? undefined;
    snap.releaseDate = meta.releaseInfo ?? meta.released ?? undefined;
    snap.description = meta.description || undefined;
  }
  return snap;
}

// ---- sorting helpers (nulls to bottom, stable) ----
function toTs(dateStr, year) {
  if (dateStr) { const t = Date.parse(dateStr); if (!Number.isNaN(t)) return t; }
  if (year)    { const t = Date.parse(`${year}-01-01`); if (!Number.isNaN(t)) return t; }
  return null;
}
function stableSort(items, sort) {
  const s = String(sort || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const key = s.split("_")[0];

  const cmpNullBottom = (a, b) => {
    const na = (a == null), nb = (b == null);
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  return items
    .map((m, i) => ({ m, i }))
    .sort((A, B) => {
      const a = A.m, b = B.m;
      let c = 0;
      if (key === "date")    c = cmpNullBottom(toTs(a.releaseDate, a.year), toTs(b.releaseDate, b.year));
      else if (key === "rating")  c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
      else if (key === "runtime") c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
      else /* name */        c = (a.name || "").localeCompare(b.name || "");
      if (c === 0) {
        c = (a.name || "").localeCompare(b.name || "");
        if (c === 0) c = (a.id || "").localeCompare(b.id || "");
        if (c === 0) c = A.i - B.i;
      }
      return c * dir;
    })
    .map(x => x.m);
}

// ---- full sync (re-discovers lists, preloads all metas) ----
async function fullSync({ rediscover = true } = {}) {
  if (syncInProgress) return;
  syncInProgress = true;
  const started = Date.now();
  try {
    // step 1: find lists
    let cfg = parseImdbListsEnv();
    if ((!cfg || cfg.length === 0) && (IMDB_USER_URL || rediscover)) {
      try { cfg = await discoverListsFromUser(IMDB_USER_URL); }
      catch (e) { console.warn("IMDb discovery failed:", e.message); cfg = []; }
    }

    // step 2: fetch ids per list
    const lists = {};
    const unique = new Set();
    for (const { name, url } of cfg) {
      const ids = await fetchImdbListIdsAllPages(url).catch(() => []);
      lists[name] = { url, ids };
      ids.forEach(id => unique.add(id));
    }
    LISTS = lists;

    // step 3: preload best meta for every unique id (movie->series)
    const idsAll = Array.from(unique);
    await mapLimit(idsAll, 8, async (tt) => {
      if (!isImdb(tt)) return null;
      return getBestMeta(tt);
    });

    LAST_SYNC_AT = Date.now();
    console.log(`[SYNC] ok in ${minutes(LAST_SYNC_AT - started)} min, ids=${idsAll.length}, lists=${Object.keys(LISTS).length}`);
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
  }, reset ? IMDB_SYNC_MINUTES * 60 * 1000 : delayMs);
}

// kick off initial sync
fullSync({ rediscover: true }).then(() => scheduleNextSync(false));

// If Render was asleep a long time, kick an async sync on first useful request.
function maybeBackgroundSync() {
  if (IMDB_SYNC_MINUTES <= 0) return;
  const tooOld = Date.now() - LAST_SYNC_AT > IMDB_SYNC_MINUTES * 60 * 1000;
  if (tooOld && !syncInProgress) fullSync({ rediscover: true }).then(() => scheduleNextSync(true));
}

// ---- server plumbing ----
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

// HEALTH
app.get("/health", (_, res) => res.status(200).send("ok"));

// MANIFEST
const baseManifest = {
  id: "org.my.csvlists",
  version: "8.0.0",
  name: "My Lists",
  description: "Your IMDb lists under one section; opens real title pages so streams load.",
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
    res.json({ ...baseManifest, catalogs: catalogs() });
  } catch (e) { console.error("Manifest error:", e); res.status(500).send("Internal Server Error"); }
});

// utils
function parseExtra(extraStr, queryObj) {
  const params = new URLSearchParams(extraStr || ""); const fromPath = Object.fromEntries(params.entries());
  return { ...fromPath, ...(queryObj || {}) };
}

// CATALOG (cache-only; triggers background sync if stale)
app.get("/catalog/:type/:id/:extra?.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const { id } = req.params;
    if (!id?.startsWith("list:")) return res.json({ metas: [] });

    const listName = id.slice(5);
    const list = LISTS[listName];
    if (!list) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q = String(extra.search || "").toLowerCase().trim();
    const sort = String(extra.sort || "name_asc").toLowerCase();
    const skip = Math.max(0, Number(extra.skip || 0));
    const limit = Math.min(Number(extra.limit || 100), 200);

    // Build snapshots fully from cache
    let snaps = (list.ids || []).map(snapshotForId);

    // search
    if (q) {
      snaps = snaps.filter(m =>
        (m.name || "").toLowerCase().includes(q) ||
        (m.id || "").toLowerCase().includes(q) ||
        (m.description || "").toLowerCase().includes(q)
      );
    }

    // sort + paginate
    snaps = stableSort(snaps, sort);
    const page = snaps.slice(skip, skip + limit);

    res.json({ metas: page });
  } catch (e) { console.error("Catalog error:", e); res.status(500).send("Internal Server Error"); }
});

// META (serve from cache; fetch on demand if missing)
app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const imdbId = req.params.id;
    if (!isImdb(imdbId))
      return res.json({ meta: { id: imdbId, type: "movie", name: "Unknown item" } });

    let rec = BEST.get(imdbId);
    if (!rec) { rec = await getBestMeta(imdbId); } // on-demand fetch if missing

    if (!rec || !rec.meta) {
      // give Stremio something to render even if Cinemeta didn't have it
      return res.json({ meta: { id: imdbId, type: rec?.kind || "movie", name: imdbId } });
    }
    return res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
  } catch (e) { console.error("Meta error:", e); res.status(500).send("Internal Server Error"); }
});

// ADMIN (IMDb only)
function absoluteBase(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}
app.get("/admin", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");

  // always rediscover to show current lists in the UI (non-blocking for cache)
  let discovered = [];
  try { if (IMDB_USER_URL) discovered = await discoverListsFromUser(IMDB_USER_URL); }
  catch { /* ignore */ }

  const manifestUrl = `${absoluteBase(req)}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;
  const uiLists = Object.entries(LISTS).map(([name, v]) => `<li><b>${name}</b> <small>(${(v.ids||[]).length} items)</small><br/><small>${v.url || ""}</small></li>`).join("") || "<li>(none)</li>";
  const discLists = discovered.length
    ? `<ul>${discovered.map(x=>`<li><b>${x.name}</b><br/><small>${x.url}</small></li>`).join("")}</ul>`
    : `<p><small>${IMDB_USER_URL ? "No public lists found (or IMDb unreachable)." : "Set IMDB_USER_URL or IMDB_LISTS in your environment."}</small></p>`;

  res.type("html").send(`<!doctype html>
<html>
<head>
  <title>My Lists – Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:760px}
    h1{margin:0 0 16px}
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
    <h3>Current Cached Lists</h3>
    <ul>${uiLists}</ul>
    <p><small>Last sync: ${LAST_SYNC_AT ? new Date(LAST_SYNC_AT).toLocaleString() + " (" + minutes(Date.now()-LAST_SYNC_AT) + " min ago)" : "never"}</small></p>
    <form method="POST" action="/api/sync-imdb?admin=${ADMIN_PASSWORD}">
      <button class="btn2">Sync IMDb Lists Now</button>
    </form>
    <p><small>Auto-sync every ${IMDB_SYNC_MINUTES} min${IMDB_SYNC_MINUTES ? "" : " (disabled)"}.</small></p>
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

// Force sync (re-discover + reset timer)
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

// start
app.listen(PORT, HOST, () => {
  console.log(`Admin: http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
});
