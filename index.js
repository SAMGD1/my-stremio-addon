// My Lists (IMDb) Stremio add-on – stable snapshot w/ robust fallbacks
// - Discovers all public lists from IMDB_USER_URL (or IMDB_LISTS whitelist)
// - Crawls every page (detail→grid→compact), preferring data-tconst per row
// - Preloads Cinemeta (movie→series); fills missing name/poster from IMDb title page
// - Cached snapshot in memory -> instant catalogs; auto-sync every IMDB_SYNC_MINUTES
// - Admin: /admin?admin=PASSWORD   Force sync: POST /api/sync-imdb?admin=PASSWORD

const express = require("express");

// ---------------- env ----------------
const PORT = Number(process.env.PORT) || 7000;
const HOST = "0.0.0.0";

const SHARED_SECRET  = process.env.SHARED_SECRET  || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_LISTS_JSON   = process.env.IMDB_LISTS || "[]";  // optional whitelist: [{ "name":"Marvel Movies", "url":"https://www.imdb.com/list/ls..." }, ...]
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

const CINEMETA = "https://v3-cinemeta.strem.io";

// Single good UA + headers; IMDb ices weak/default fetches sometimes.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BASE_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Connection": "keep-alive"
};

// ---------------- state ----------------
/** { [listName]: { url, ids: string[] } } */
let LISTS = {};
/** Map<tt, {kind:'movie'|'series'|null, meta:object|null}> */
const BEST = new Map();
/** Map<tt, {name?:string,poster?:string}> from IMDb title page (fallbacks) */
const FALLBACK = new Map();
/** Prebuilt tiles for instant catalogs: Map<tt, card> */
const CARDS = new Map();
/** last sync */
let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;

// ---------------- small utils ----------------
const isImdb = (v) => /^tt\d{7,}$/.test(String(v || ""));
const minutes = (ms) => Math.round(ms / 60000);
const nowIso = () => new Date().toISOString();

function withParam(url, key, val) {
  const u = new URL(url);
  u.searchParams.set(key, String(val));
  return u.toString();
}

async function fetchText(url) {
  // cache-buster + steady headers
  const bust = withParam(url, "_", Date.now());
  const r = await fetch(bust, { headers: BASE_HEADERS });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}

async function fetchJson(url) {
  const bust = withParam(url, "_", Date.now());
  const r = await fetch(bust, {
    headers: { "User-Agent": UA, "Accept": "application/json" }
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

// concurrency helper
async function mapLimit(arr, limit, fn) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const results = new Array(arr.length);
  let i = 0;
  const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (i < arr.length) {
      const idx = i++;
      try { results[idx] = await fn(arr[idx], idx); }
      catch { results[idx] = undefined; }
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------- discovery: lists for user ----------------
function parseImdbListsEnv() {
  try {
    const arr = JSON.parse(IMDB_LISTS_JSON);
    if (Array.isArray(arr)) {
      return arr
        .filter(x => x && x.name && x.url)
        .map(x => ({ name: String(x.name), url: String(x.url) }));
    }
  } catch {}
  return [];
}

async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  let html;
  try { html = await fetchText(userListsUrl); }
  catch { return []; }

  // pick only proper list links; keep display name
  const found = new Map();
  // Most stable anchor on that page is the link to /list/ls##########/
  const re = /<a[^>]+href="\/list\/(ls\d{6,})\/"[^>]*>(.*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const raw = m[2] || "";
    const name = raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!found.has(id) && name) {
      found.set(id, { name, url: `https://www.imdb.com/list/${id}/` });
    }
  }
  return Array.from(found.values());
}

// ---------------- list pages: grab tconsts safely ----------------

// Extract only the tconst that belongs to the list row.
// Strategy: look for list-row blocks then prefer data-tconst.
// Fall back to the first /title/.. link inside that block.
function tconstsFromListPage(html) {
  const out = [];
  const seen = new Set();

  // Try multiple container types (old & new UI)
  const rowRe = /<(?:li|div)[^>]+class="[^"]*(?:ipc-metadata-list-summary-item|lister-item|lister-item-content)[^"]*"[^>]*>([\s\S]*?)<\/(?:li|div)>/gi;
  let m;
  while ((m = rowRe.exec(html))) {
    const block = m[1];

    // 1) prefer data-tconst
    let m1 = block.match(/data-tconst="(tt\d{7,})"/i);
    let tt = m1 ? m1[1] : null;

    // 2) fallback: first /title/… in that row (NOT every /title/ on the page)
    if (!tt) {
      const m2 = block.match(/href="\/title\/(tt\d{7,})\//i);
      tt = m2 ? m2[1] : null;
    }

    if (tt && !seen.has(tt)) {
      seen.add(tt);
      out.push(tt);
    }
  }

  // Last resort (if container detection failed), use global data-tconst presence
  if (out.length === 0) {
    let g;
    const reGlobal = /data-tconst="(tt\d{7,})"/gi;
    while ((g = reGlobal.exec(html))) {
      const tt = g[1];
      if (!seen.has(tt)) { seen.add(tt); out.push(tt); }
    }
  }

  return out;
}

function findNextLink(html) {
  // follow "next" pagination from either UI
  let m =
    html.match(/<a[^>]+rel="next"[^>]+href="([^"]+)"/i) ||
    html.match(/<a[^>]+class="[^"]*lister-page-next[^"]*"[^>]+href="([^"]+)"/i) ||
    html.match(/<a[^>]+data-testid="pagination-next-page-button"[^>]+href="([^"]+)"/i);

  if (!m) return null;
  try { return new URL(m[1], "https://www.imdb.com").toString(); }
  catch { return null; }
}

async function fetchImdbListIdsAllPages(listUrl, maxPages = 80) {
  const modes = ["detail", "grid", "compact"]; // try all, stop at first that yields items
  const unique = new Set();
  let usedMode = null;

  for (let k = 0; k < modes.length; k++) {
    unique.clear();
    usedMode = modes[k];
    let url = withParam(listUrl, "mode", usedMode);
    let pages = 0;

    while (url && pages < maxPages) {
      let html;
      try { html = await fetchText(url); }
      catch { break; }

      const ids = tconstsFromListPage(html);
      let added = 0;
      for (let i = 0; i < ids.length; i++) {
        const tt = ids[i];
        if (isImdb(tt) && !unique.has(tt)) { unique.add(tt); added++; }
      }

      pages++;
      const nextUrl = findNextLink(html);
      if (!nextUrl || added === 0) break; // end of that mode
      url = nextUrl;
    }

    if (unique.size > 0) break; // success in this mode
  }

  return Array.from(unique);
}

// ---------------- Cinemeta + IMDb title fallback ----------------
async function fetchCinemeta(kind, imdbId) {
  try {
    const j = await fetchJson(`${CINEMETA}/meta/${encodeURIComponent(kind)}/${encodeURIComponent(imdbId)}.json`);
    return j && j.meta ? j.meta : null;
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

// pull name & poster from IMDb title page (JSON-LD → OG)
// used only when Cinemeta doesn't give us at least the name/poster
async function fetchImdbTitleFallback(tt) {
  if (FALLBACK.has(tt)) return FALLBACK.get(tt);
  let name = null, poster = null;
  try {
    const html = await fetchText(`https://www.imdb.com/title/${tt}/`);

    // JSON-LD (prefer)
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        const node = Array.isArray(j && j["@graph"]) ? j["@graph"][0] : j;
        if (node && typeof node === "object") {
          if (typeof node.name === "string") name = node.name;
          if (!name && typeof node.headline === "string") name = node.headline;

          if (typeof node.image === "string") poster = node.image;
          else if (node.image && typeof node.image.url === "string") poster = node.image.url;
        }
      } catch {}
    }

    // OpenGraph fallback
    if (!name) {
      const t = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
      if (t) name = t[1];
    }
    if (!poster) {
      const p = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
      if (p) poster = p[1];
    }
  } catch {}

  const entry = { name: name || undefined, poster: poster || undefined };
  FALLBACK.set(tt, entry);
  return entry;
}

// Make one card for catalogs from BEST + FALLBACK
function extractReleaseTs(meta) {
  // Try several shapes; return a unix ts (or null)
  // 1) meta.released (YYYY-MM-DD)
  if (meta && typeof meta.released === "string") {
    const t = Date.parse(meta.released);
    if (!Number.isNaN(t)) return t;
  }
  // 2) meta.releaseInfo may be string/array/object; find earliest YYYY-MM-DD
  if (meta && meta.releaseInfo) {
    const pick = (val) => {
      if (typeof val === "string") {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) return t;
      }
      return null;
    };
    if (Array.isArray(meta.releaseInfo)) {
      let best = null;
      for (let i = 0; i < meta.releaseInfo.length; i++) {
        const t = pick(meta.releaseInfo[i]);
        if (t !== null && (best === null || t < best)) best = t;
      }
      if (best !== null) return best;
    } else {
      const t = pick(meta.releaseInfo);
      if (t !== null) return t;
    }
  }
  // 3) fallback to Jan 1 of the year
  if (meta && typeof meta.year === "number") {
    const t = Date.parse(String(meta.year) + "-01-01");
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

function buildCard(tt) {
  const rec  = BEST.get(tt) || { kind: null, meta: null };
  const meta = rec.meta || null;
  const fb   = FALLBACK.get(tt) || {};

  const name = (meta && typeof meta.name === "string" && meta.name.trim()) ? meta.name : (fb.name || tt);
  const poster = (meta && typeof meta.poster === "string" && meta.poster) ? meta.poster : (fb.poster || undefined);

  const card = {
    id: tt,
    type: rec.kind || "movie",
    name,
    poster,
    background: meta && typeof meta.background === "string" ? meta.background : undefined,
    logo:       meta && typeof meta.logo       === "string" ? meta.logo       : undefined,
    imdbRating: meta && typeof meta.imdbRating !== "undefined" ? meta.imdbRating :
                (meta && typeof meta.rating     !== "undefined" ? meta.rating : undefined),
    runtime:    meta && typeof meta.runtime     !== "undefined" ? meta.runtime : undefined,
    year:       meta && typeof meta.year        !== "undefined" ? meta.year    : undefined,
    releaseDateTs: extractReleaseTs(meta), // internal for sorting
    description: meta && typeof meta.description === "string" ? meta.description : undefined
  };

  return card;
}

// ---------------- sorting ----------------
function stableSort(items, sortKey) {
  const s = String(sortKey || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const key = s.split("_")[0];

  const cmpNullBottom = (a, b) => {
    const na = (a === null || typeof a === "undefined");
    const nb = (b === null || typeof b === "undefined");
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return a < b ? -1 : (a > b ? 1 : 0);
  };

  return items
    .map((m, i) => ({ m, i }))
    .sort((A, B) => {
      const a = A.m, b = B.m;
      let c = 0;
      if (key === "date")    c = cmpNullBottom(a.releaseDateTs || null, b.releaseDateTs || null);
      else if (key === "rating")  c = cmpNullBottom(a.imdbRating, b.imdbRating);
      else if (key === "runtime") c = cmpNullBottom(a.runtime, b.runtime);
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

// ---------------- full sync ----------------
async function fullSync({ rediscover = true } = {}) {
  if (syncInProgress) return;
  syncInProgress = true;

  try {
    // 1) discover lists
    let cfg = parseImdbListsEnv();
    if ((!cfg || cfg.length === 0) && (IMDB_USER_URL && rediscover)) {
      try {
        const d = await discoverListsFromUser(IMDB_USER_URL);
        cfg = d;
      } catch (e) {
        console.warn("IMDb discovery failed:", e.message || e);
        cfg = [];
      }
    }

    // 2) fetch ids per list
    const next = {};
    const allIds = new Set();

    for (let i = 0; i < cfg.length; i++) {
      const { name, url } = cfg[i];
      let ids = [];
      try { ids = await fetchImdbListIdsAllPages(url); }
      catch (e) { console.warn("List fetch failed:", name, e.message || e); }
      next[name] = { url, ids };
      for (let j = 0; j < ids.length; j++) allIds.add(ids[j]);
    }
    LISTS = next;

    // 3) preload Cinemeta for all unique ids
    const idsArr = Array.from(allIds);
    await mapLimit(idsArr, 8, async (tt) => { if (isImdb(tt)) await getBestMeta(tt); });

    // 4) build cards + IMDb title fallbacks where needed
    CARDS.clear();
    await mapLimit(idsArr, 6, async (tt) => {
      const rec = BEST.get(tt) || { kind: null, meta: null };
      const meta = rec.meta;
      let card = null;

      // Need fallback if no meta or missing name/poster
      let needName = true, needPoster = true;
      if (meta) {
        if (typeof meta.name   === "string" && meta.name.trim()) needName = false;
        if (typeof meta.poster === "string" && meta.poster)       needPoster = false;
      }

      if (needName || needPoster) {
        await fetchImdbTitleFallback(tt);
      }
      card = buildCard(tt);
      CARDS.set(tt, card);
    });

    LAST_SYNC_AT = Date.now();
    console.log(`[SYNC] ok – ${idsArr.length} ids across ${Object.keys(LISTS).length} lists in ~${minutes(Date.now()-LAST_SYNC_AT)} min (wall).`);
  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    syncInProgress = false;
  }
}

function scheduleNextSync(reset) {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  if (IMDB_SYNC_MINUTES <= 0) return;
  const delayMs = IMDB_SYNC_MINUTES * 60 * 1000;
  syncTimer = setTimeout(async () => {
    await fullSync({ rediscover: true });
    scheduleNextSync(true);
  }, reset ? delayMs : delayMs);
}

// Cold-start kick
fullSync({ rediscover: true }).then(() => scheduleNextSync(false));

// If the dyno slept, refresh in background on first traffic
function maybeBackgroundSync() {
  if (IMDB_SYNC_MINUTES <= 0) return;
  const stale = Date.now() - LAST_SYNC_AT > IMDB_SYNC_MINUTES * 60 * 1000;
  if (stale && !syncInProgress) fullSync({ rediscover: true }).then(() => scheduleNextSync(true));
}

// ---------------- server ----------------
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

// manifest
const baseManifest = {
  id: "org.my.csvlists",
  version: "8.5.0",
  name: "My Lists",
  description: "Your IMDb lists; instant catalogs from a local snapshot.",
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
  } catch (e) {
    console.error("Manifest error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// parse extra
function parseExtra(extraStr, queryObj) {
  const params = new URLSearchParams(extraStr || "");
  const fromPath = Object.fromEntries(params.entries());
  return { ...fromPath, ...(queryObj || {}) };
}

// catalog (instant from CARDS)
app.get("/catalog/:type/:id/:extra?.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const { id } = req.params;
    if (!id || !id.startsWith("list:")) return res.json({ metas: [] });

    const name = id.slice(5);
    const list = LISTS[name];
    if (!list || !Array.isArray(list.ids) || list.ids.length === 0) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q = String(extra.search || "").toLowerCase().trim();
    const sort = String(extra.sort || "name_asc").toLowerCase();
    const skip = Math.max(0, Number(extra.skip || 0));
    const limit = Math.min(Number(extra.limit || 100), 200);

    let metas = list.ids.map(tt => {
      const c = CARDS.get(tt);
      if (c) return c;
      const fb = FALLBACK.get(tt) || {};
      return { id: tt, type: "movie", name: fb.name || tt, poster: fb.poster || undefined, releaseDateTs: null };
    });

    if (q) {
      metas = metas.filter(m =>
        (m.name || "").toLowerCase().includes(q) ||
        (m.id || "").toLowerCase().includes(q) ||
        (m.description || "").toLowerCase().includes(q)
      );
    }

    metas = stableSort(metas, sort);
    const page = metas.slice(skip, skip + limit);

    // remove internal field before returning
    page.forEach(x => { if (typeof x.releaseDateTs !== "undefined") delete x.releaseDateTs; });

    res.json({ metas: page });
  } catch (e) {
    console.error("Catalog error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// meta (serve cached Cinemeta; minimal fallback)
app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const imdbId = req.params.id;
    if (!isImdb(imdbId)) return res.json({ meta: { id: imdbId, type: "movie", name: "Unknown item" } });

    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);

    if (!rec || !rec.meta) {
      const fb = FALLBACK.get(imdbId) || {};
      return res.json({ meta: { id: imdbId, type: rec && rec.kind ? rec.kind : "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
    }
    return res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind || "movie" } });
  } catch (e) {
    console.error("Meta error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// admin
app.get("/admin", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");

  let discoveredHtml = "<p><small>Set IMDB_USER_URL to auto-discover public lists.</small></p>";
  if (IMDB_USER_URL) {
    try {
      const d = await discoverListsFromUser(IMDB_USER_URL);
      discoveredHtml = d.length
        ? `<ul>${d.map(x => `<li><b>${x.name}</b><br/><small>${x.url}</small></li>`).join("")}</ul>`
        : "<p><small>No public lists found (or IMDb unreachable right now).</small></p>";
    } catch {
      discoveredHtml = "<p><small>IMDb unreachable right now.</small></p>";
    }
  }

  const uiLists = Object.entries(LISTS).map(([n, v]) =>
    `<li><b>${n}</b> <small>(${(v.ids || []).length} items)</small><br/><small>${v.url || ""}</small></li>`
  ).join("") || "<li>(none)</li>";

  const manifestUrl = `${absoluteBase(req)}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;

  res.type("html").send(`<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Admin</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:760px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
button{padding:10px 16px;border:0;border-radius:8px;background:#6c5ce7;color:#fff;cursor:pointer}
small{color:#666}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}
.btn2{background:#2d6cdf}
</style>
</head><body>
  <h1>My Lists – Admin</h1>

  <div class="card">
    <h3>Current Snapshot</h3>
    <ul>${uiLists}</ul>
    <p><small>Last sync: ${LAST_SYNC_AT ? new Date(LAST_SYNC_AT).toLocaleString() + " (" + minutes(Date.now()-LAST_SYNC_AT) + " min ago)" : "never"}</small></p>
    <form method="POST" action="/api/sync-imdb?admin=${ADMIN_PASSWORD}">
      <button class="btn2">Sync IMDb Lists Now</button>
    </form>
    <p><small>Auto-sync every ${IMDB_SYNC_MINUTES} min${IMDB_SYNC_MINUTES ? "" : " (disabled)"}.</small></p>
  </div>

  <div class="card">
    <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
    ${discoveredHtml}
  </div>

  <div class="card">
    <h3>Manifest URL</h3>
    <p class="code">${manifestUrl}</p>
  </div>
</body></html>`);
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

// start
app.listen(PORT, HOST, () => {
  console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
});
