/* My Lists (IMDb) → Stremio
 * v8.3 – stable tiles, IMDb fallback, no episodes, IMDb-order sort, auto/force sync
 */

const express = require("express");

// ---------------- ENV ----------------
const PORT = Number(process.env.PORT) || 7000;
const HOST = "0.0.0.0";

const SHARED_SECRET  = process.env.SHARED_SECRET  || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const IMDB_USER_URL  = process.env.IMDB_USER_URL  || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_LISTS_JSON= process.env.IMDB_LISTS     || "[]"; // optional whitelist: [{ name, url }]
const IMDB_SYNC_MIN  = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

const CINEMETA = "https://v3-cinemeta.strem.io";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyLists/8.3";

// --------------- STATE ---------------
/** {[listName]: { url, ids: string[], order: {[tt]: index} }} */
let LISTS = {};
/** Map<tt, { kind:'movie'|'series'|null, meta:object|null }> */
const BEST = new Map();
/** IMDb fallback: Map<tt, { name?:string, poster?:string, isEpisode?:boolean }> */
const FALLBACK = new Map();
/** Prebuilt catalog cards: Map<tt, card> */
const CARDS = new Map();

let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;
let MANIFEST_REV = 1;                 // bump when list set changes
let LAST_LISTS_KEY = "";

// ------------- HELPERS --------------
const isImdb = v => /^tt\d{7,}$/i.test(String(v || ""));
const nowIso = () => new Date().toISOString();
const minToMs = m => m * 60 * 1000;
const listsKey = () => JSON.stringify(Object.keys(LISTS).sort());
const headers = { "User-Agent": UA };

async function fetchText(url) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { ...headers, Accept: "application/json" } });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}
function withParam(url, key, val) {
  const u = new URL(url);
  u.searchParams.set(key, val);
  return u.toString();
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

// -------- IMDb LIST DISCOVERY -------
function fromEnvLists() {
  try {
    const arr = JSON.parse(IMDB_LISTS_JSON);
    if (Array.isArray(arr)) return arr.filter(x => x && x.name && x.url);
  } catch (_) {}
  return [];
}

async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(withParam(userListsUrl, "_", Date.now().toString()));
  const found = new Map();
  // anchors like /list/ls##########/ >List Title<
  const re = /<a[^>]+href="\/list\/(ls\d{6,})\/"[^>]*>(.*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const name = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!found.has(id) && name) found.set(id, { name, url: `https://www.imdb.com/list/${id}/` });
  }
  return Array.from(found.values());
}

function idsFromHtmlInPageOrder(html) {
  // prefer data-tconst (grid/new UI). Fallback to /title/ links.
  const order = [];
  const seen = new Set();
  let m;

  const reData = /data-tconst="(tt\d{7,})"/gi;
  while ((m = reData.exec(html))) {
    const tt = m[1];
    if (!seen.has(tt)) { seen.add(tt); order.push(tt); }
  }

  const reAny = /href="\/title\/(tt\d{7,})\//gi;
  while ((m = reAny.exec(html))) {
    const tt = m[1];
    if (!seen.has(tt)) { seen.add(tt); order.push(tt); }
  }
  return order;
}
function nextPageUrl(html) {
  let m = html.match(/<a[^>]+rel="next"[^>]+href="([^"]+)"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*lister-page-next[^"]*"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*data-testid="pagination-next-page-button"[^>]*>/i);
  return m ? new URL(m[1], "https://www.imdb.com").toString() : null;
}

async function fetchListIdsAllPages(listUrl, maxPages = 50) {
  const ids = [];
  const orderMap = {};
  let url = withParam(listUrl, "_", Date.now().toString());
  let page = 0;
  while (url && page < maxPages) {
    const html = await fetchText(url);
    const pageIds = idsFromHtmlInPageOrder(html);
    for (const tt of pageIds) {
      if (orderMap[tt] === undefined) {
        orderMap[tt] = ids.length;
        ids.push(tt);
      }
    }
    const n = nextPageUrl(html);
    if (!n || pageIds.length === 0) break;
    url = withParam(n, "_", Date.now().toString());
    page++;
  }
  return { ids, orderMap };
}

// ---- IMDb TITLE FALLBACK (JSON-LD) ----
function parseJsonLd(str) {
  try {
    const j = JSON.parse(str);
    if (Array.isArray(j?.["@graph"])) return j["@graph"][0] || j;
    return j || null;
  } catch { return null; }
}
async function fetchImdbFallback(tt) {
  try {
    const html = await fetchText(`https://www.imdb.com/title/${tt}/`);
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    let name=null, image=null, isEpisode=false;
    if (m) {
      const node = parseJsonLd(m[1]);
      if (node) {
        const t = node["@type"];
        isEpisode = String(t).toLowerCase().includes("episode");
        name = node.name || node.headline || null;
        if (typeof node.image === "string") image = node.image;
        else if (node.image && typeof node.image.url === "string") image = node.image.url;
      }
    }
    if (!name) {
      const t = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
      if (t) name = t[1];
    }
    if (!image) {
      const p = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
      if (p) image = p[1];
    }
    return { name: name || undefined, poster: image || undefined, isEpisode };
  } catch {
    return { name: undefined, poster: undefined, isEpisode: false };
  }
}

// ------------- CINEMETA --------------
async function fetchCinemeta(kind, imdbId) {
  try {
    const obj = await fetchJson(`${CINEMETA}/meta/${encodeURIComponent(kind)}/${encodeURIComponent(imdbId)}.json`);
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

// ----------- CARD BUILDER ------------
function buildCard(tt) {
  const rec = BEST.get(tt) || { kind: null, meta: null };
  const meta = rec.meta;
  const fb = FALLBACK.get(tt) || {};

  return {
    id: tt,
    type: rec.kind || "movie",
    // prefer IMDb title/poster -> avoids mismatched tiles
    name: (fb.name || (meta && meta.name) || tt),
    poster: (fb.poster || (meta && meta.poster) || undefined),
    background: meta && meta.background || undefined,
    logo: meta && meta.logo || undefined,
    imdbRating: meta ? (meta.imdbRating ?? meta.rating ?? undefined) : undefined,
    runtime: meta ? (meta.runtime ?? undefined) : undefined,
    year: meta ? (meta.year ?? undefined) : undefined,
    releaseDate: meta ? (meta.releaseInfo ?? meta.released ?? undefined) : undefined,
    description: meta && meta.description || undefined
  };
}

// --------------- SORTING -------------
function toTs(dateStr, year) {
  if (dateStr) {
    const n = Date.parse(dateStr);
    if (!Number.isNaN(n)) return n;
  }
  if (year) {
    const n = Date.parse(`${year}-01-01`);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}
function stableSort(items, sortKey, orderMap) {
  const s = String(sortKey || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const key = s.split("_")[0];

  const cmpNullBottom = (a, b) => {
    const na = (a === null || a === undefined);
    const nb = (b === null || b === undefined);
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
      if (key === "date") { // keep legacy name, but it means IMDb list ORDER
        const oa = orderMap[a.id] ?? Number.MAX_SAFE_INTEGER;
        const ob = orderMap[b.id] ?? Number.MAX_SAFE_INTEGER;
        c = oa - ob;
      } else if (key === "rating") c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
      else if (key === "runtime") c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
      else if (key === "released") c = cmpNullBottom(toTs(a.releaseDate, a.year), toTs(b.releaseDate, b.year));
      else c = (a.name || "").localeCompare(b.name || "");
      if (c === 0) {
        c = (a.name || "").localeCompare(b.name || "");
        if (c === 0) c = (a.id || "").localeCompare(b.id || "");
        if (c === 0) c = A.i - B.i;
      }
      return c * dir;
    })
    .map(x => x.m);
}

// ---------------- SYNC ----------------
async function fullSync({ rediscover = true } = {}) {
  if (syncInProgress) return;
  syncInProgress = true;
  try {
    // 1) which lists?
    let cfg = fromEnvLists();
    if ((!cfg || cfg.length === 0) && (IMDB_USER_URL && rediscover)) {
      try { cfg = await discoverListsFromUser(IMDB_USER_URL); }
      catch (e) { console.warn("IMDb discovery failed:", e.message); cfg = []; }
    }

    // 2) fetch ids (in page order) for each list
    const nextLISTS = {};
    const allIds = new Set();
    for (const L of cfg) {
      try {
        const { ids, orderMap } = await fetchListIdsAllPages(L.url);
        nextLISTS[L.name] = { url: L.url, ids, order: orderMap };
        ids.forEach(id => allIds.add(id));
      } catch (e) {
        console.warn("List fetch failed:", L.name, e.message);
        nextLISTS[L.name] = { url: L.url, ids: [], order: {} };
      }
    }

    // 3) preload Cinemeta for all ids (movie→series)
    const uniqueIds = Array.from(allIds);
    await mapLimit(uniqueIds, 8, async (tt) => { if (isImdb(tt)) await getBestMeta(tt); });

    // 4) IMDb title fallback for all ids (fills names/posters and detects episodes)
    await mapLimit(uniqueIds, 6, async (tt) => {
      if (!FALLBACK.has(tt)) {
        const fb = await fetchImdbFallback(tt);
        FALLBACK.set(tt, fb);
      }
    });

    // 5) drop EPISODES (kept: movies/series/TV movies/specials/etc.)
    const keepSet = new Set(uniqueIds.filter(tt => !FALLBACK.get(tt)?.isEpisode));

    for (const name of Object.keys(nextLISTS)) {
      const L = nextLISTS[name];
      L.ids = (L.ids || []).filter(tt => keepSet.has(tt));
      // rebuild orderMap to reflect any removed items
      const om = {};
      L.ids.forEach((tt, i) => { om[tt] = i; });
      L.order = om;
    }

    // 6) build cards
    CARDS.clear();
    for (const tt of keepSet) CARDS.set(tt, buildCard(tt));

    // 7) swap lists + bump manifest if set changed
    LISTS = nextLISTS;
    const key = listsKey();
    if (key !== LAST_LISTS_KEY) {
      LAST_LISTS_KEY = key;
      MANIFEST_REV += 1;
      console.log("[SYNC] catalogs changed → manifest rev", MANIFEST_REV);
    }

    LAST_SYNC_AT = Date.now();
    console.log(`[SYNC] ids=${keepSet.size} lists=${Object.keys(LISTS).length}`);
  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    syncInProgress = false;
  }
}
function scheduleNextSync(reset) {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  if (IMDB_SYNC_MIN <= 0) return;
  const delay = minToMs(IMDB_SYNC_MIN);
  syncTimer = setTimeout(async () => {
    await fullSync({ rediscover: true });
    scheduleNextSync(true);
  }, reset ? delay : delay);
}
function maybeBackgroundSync() {
  if (IMDB_SYNC_MIN <= 0) return;
  const tooOld = Date.now() - LAST_SYNC_AT > minToMs(IMDB_SYNC_MIN);
  if (tooOld && !syncInProgress) fullSync({ rediscover: true }).then(() => scheduleNextSync(true));
}

// -------------- SERVER ---------------
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

// Manifest (no-cache; auto version bump so you never need to reinstall)
const baseManifest = {
  id: "org.my.csvlists",
  version: "8.3.0",                       // will become 8.3.X
  name: "My Lists",
  description: "Your IMDb lists as instant catalogs (IMDb titles/posters, no episodes).",
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
      // "date_*" means IMDb list order (what you see on the list page)
      { name: "sort", options: ["date_asc","date_desc","name_asc","name_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","released_asc","released_desc"] }
    ],
    posterShape: "poster"
  }));
}
app.get("/manifest.json", (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    const version = `8.3.${MANIFEST_REV}`;
    res.json({ ...baseManifest, version, catalogs: catalogs() });
  } catch (e) {
    console.error("Manifest error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Catalog
function parseExtra(extraStr, queryObj) {
  const params = new URLSearchParams(extraStr || "");
  const fromPath = Object.fromEntries(params.entries());
  return { ...fromPath, ...(queryObj || {}) };
}
app.get("/catalog/:type/:id/:extra?.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    res.setHeader("Cache-Control", "no-store");
    maybeBackgroundSync();

    const { id } = req.params;
    if (!id || !id.startsWith("list:")) return res.json({ metas: [] });

    const listName = id.slice(5);
    const L = LISTS[listName];
    if (!L || !Array.isArray(L.ids) || !L.ids.length) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q = String(extra.search || "").toLowerCase().trim();
    const sort = String(extra.sort || "name_asc").toLowerCase();
    const skip = Math.max(0, Number(extra.skip || 0));
    const limit = Math.min(Number(extra.limit || 100), 200);

    let metas = L.ids.map(tt => CARDS.get(tt) || buildCard(tt));

    if (q) {
      metas = metas.filter(m =>
        (m.name || "").toLowerCase().includes(q) ||
        (m.description || "").toLowerCase().includes(q) ||
        (m.id || "").toLowerCase().includes(q)
      );
    }

    metas = stableSort(metas, sort, L.order || {});
    const page = metas.slice(skip, skip + limit);

    res.json({ metas: page });
  } catch (e) {
    console.error("Catalog error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Meta (serve Cinemeta if present, otherwise minimal with IMDb fallback)
app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    res.setHeader("Cache-Control", "no-store");
    maybeBackgroundSync();

    const imdbId = req.params.id;
    if (!isImdb(imdbId))
      return res.json({ meta: { id: imdbId, type: "movie", name: "Unknown item" } });

    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);

    const fb = FALLBACK.get(imdbId) || {};
    if (!rec || !rec.meta) {
      return res.json({ meta: { id: imdbId, type: (rec && rec.kind) || "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
    }
    // Prefer Cinemeta meta, but keep IMDb name/poster to match catalog tiles
    const merged = { ...rec.meta, id: imdbId, type: rec.kind };
    if (fb.name)   merged.name = fb.name;
    if (fb.poster) merged.poster = fb.poster;
    return res.json({ meta: merged });
  } catch (e) {
    console.error("Meta error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Admin
function manifestUrl(req) {
  return `${absoluteBase(req)}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;
}
app.get("/admin", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");

  // show live discovery (non-blocking)
  let discoveredHtml = `<p><small>${IMDB_USER_URL ? "No public lists found (or IMDb temporarily unreachable)." : "Set IMDB_USER_URL or IMDB_LISTS in Render → Environment."}</small></p>`;
  if (IMDB_USER_URL) {
    try {
      const discovered = await discoverListsFromUser(IMDB_USER_URL);
      if (discovered.length) {
        discoveredHtml = `<ul>${discovered.map(x => `<li><b>${x.name}</b><br/><small>${x.url}</small></li>`).join("")}</ul>`;
      }
    } catch (_) {}
  }

  const names = Object.keys(LISTS);
  const listHtml = names.length
    ? `<ul>${names.map(n => `<li><b>${n}</b> <small>(${(LISTS[n].ids||[]).length} items)</small><br/><small>${LISTS[n].url || ""}</small></li>`).join("")}</ul>`
    : "<p>(no lists yet)</p>";

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
    ${listHtml}
    <p><small>Last sync: ${LAST_SYNC_AT ? new Date(LAST_SYNC_AT).toLocaleString() + " (" + Math.round((Date.now()-LAST_SYNC_AT)/60000) + " min ago)" : "never"}</small></p>
    <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}">
      <button class="btn2">Sync IMDb Lists Now</button>
    </form>
    <p><small>Auto-sync every ${IMDB_SYNC_MIN} min${IMDB_SYNC_MIN ? "" : " (disabled)"}.</small></p>
  </div>

  <div class="card">
    <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
    ${discoveredHtml}
  </div>

  <div class="card">
    <h3>Manifest URL</h3>
    <p class="code">${manifestUrl(req)}</p>
  </div>
</body></html>`);
});

app.post("/api/sync", async (req, res) => {
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

// -------- BOOT / START --------
(async () => {
  // initial sync (non-blocking)
  fullSync({ rediscover: true }).then(() => scheduleNextSync(false));
  app.listen(PORT, HOST, () => {
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
  });
})();
