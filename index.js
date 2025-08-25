/*  My Lists – IMDb → Stremio add-on
 *  v10.0  —  discovers lists from IMDB_USER_URL, accurate titles/posters,
 *             correct type (movie vs series), episode → series collapse,
 *             real date sorting, auto/force sync.
 */

const express = require("express");

// ---------- ENV ----------
const PORT = Number(process.env.PORT) || 7000;
const HOST = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

const IMDB_USER_URL     = (process.env.IMDB_USER_URL || "").trim(); // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

// collapse TVEpisodes to parent TVSeries tiles
const COLLAPSE_EPISODES = (process.env.COLLAPSE_EPISODES || "1") !== "0";

const CINEMETA = "https://v3-cinemeta.strem.io";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyLists/10.0 (+stremio)";

// ---------- STATE ----------
/** lists: { [name]: { url: string, ids: string[] } } */
let LISTS = Object.create(null);

/** map imdbId -> best Cinemeta {kind, meta}  (kind: "movie"|"series"|null) */
const BEST = new Map();

/** map imdbId -> imdb fallback {name, poster, type, datePublished, duration, seriesId?} */
const IMDB = new Map();

/** if we collapse episodes, track mapping ep -> series */
const EP_TO_SERIES = new Map();

let LAST_SYNC_AT = 0;
let SYNCING = false;
let SYNC_TIMER = null;

// ---------- UTILS ----------
const isImdb = v => /^tt\d{7,}$/i.test(String(v || ""));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const minToMs = m => m * 60 * 1000;

function addNoCache(url) {
  const u = new URL(url);
  u.searchParams.set("_", Date.now().toString());
  return u.toString();
}

async function fetchText(url, accept = "text/html") {
  const r = await fetch(addNoCache(url), {
    headers: { "User-Agent": UA, "Accept": accept }
  });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(addNoCache(url), {
    headers: { "User-Agent": UA, "Accept": "application/json" }
  });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- IMDB LIST DISCOVERY ----------
async function discoverListsFromUserPage(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(userListsUrl);

  // Extract blocks that look like a list tile with a link to /list/ls##########/
  const found = new Map();
  // Title link and visible name
  const re = /<a[^>]+href="\/list\/(ls\d{6,})\/"[^>]*>(.*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const name = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!found.has(id) && name) {
      found.set(id, { id, name, url: `https://www.imdb.com/list/${id}/` });
    }
  }
  return Array.from(found.values());
}

// ---------- IMDB LIST ITEMS (with pagination) ----------
function tconstsFromHtml(html) {
  const set = new Set();
  let m;
  // data-tconst (new UI)
  const re1 = /data-tconst="(tt\d{7,})"/gi;
  while ((m = re1.exec(html))) set.add(m[1]);
  // any /title/tt#######/ links (fallback)
  const re2 = /\/title\/(tt\d{7,})\//gi;
  while ((m = re2.exec(html))) set.add(m[1]);
  return Array.from(set);
}
function nextPageUrl(html, base) {
  let m = html.match(/<a[^>]+rel="next"[^>]+href="([^"]+)"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*lister-page-next[^"]*"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*data-testid="pagination-next-page-button"[^>]*>/i);
  if (!m) return null;
  try { return new URL(m[1], base).toString(); } catch { return null; }
}
async function fetchListIdsAllPages(listUrl, maxPages = 50) {
  const out = [];
  const seen = new Set();
  let url = listUrl;
  let pages = 0;

  while (url && pages < maxPages) {
    let html;
    try { html = await fetchText(url); }
    catch { break; }

    const ids = tconstsFromHtml(html);
    let added = 0;
    for (const tt of ids) {
      if (!seen.has(tt)) { seen.add(tt); out.push(tt); added++; }
    }
    pages++;
    const nxt = nextPageUrl(html, listUrl);
    if (!nxt || added === 0) break;
    url = nxt;
    // small pause so IMDb doesn’t get cranky
    await sleep(100);
  }

  return out;
}

// ---------- IMDB TITLE FALLBACK (JSON-LD) ----------
function parseIsoDurationMinutes(iso) {
  // e.g. PT45M, PT1H20M
  if (!iso || typeof iso !== "string") return null;
  const h = /(\d+)H/.exec(iso); const m = /(\d+)M/.exec(iso);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0) || null;
}
async function fetchImdbFallback(imdbId) {
  if (IMDB.has(imdbId)) return IMDB.get(imdbId);
  let info = { name: null, poster: null, type: null, datePublished: null, duration: null, seriesId: null };
  try {
    const html = await fetchText(`https://www.imdb.com/title/${imdbId}/`);
    // JSON-LD — might be multiple; find the node that has Movie/TVSeries/TVEpisode
    const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];
    for (const s of scripts) {
      try {
        const j = JSON.parse(s[1]);
        const nodes = Array.isArray(j) ? j : (j["@graph"] || [j]);
        for (const node of nodes) {
          const t = node["@type"];
          if (!t) continue;
          const types = Array.isArray(t) ? t : [t];
          const hasType = (v) => types.includes(v);

          if (hasType("Movie") || hasType("TVSeries") || hasType("TVEpisode")) {
            if (!info.name)   info.name   = node.name || node.headline || null;
            if (!info.poster) info.poster = (typeof node.image === "string" ? node.image : node.image?.url) || null;
            if (!info.datePublished) info.datePublished = node.datePublished || null;
            if (!info.duration)      info.duration      = parseIsoDurationMinutes(node.duration) || null;

            if (hasType("Movie")) info.type = "movie";
            else if (hasType("TVSeries")) info.type = "series";
            else if (hasType("TVEpisode")) {
              info.type = "episode";
              // try to find parent series
              let sid = null;
              const seriesNode = node.partOfSeries || node.isPartOf || node.isPartOfSeries;
              if (seriesNode && typeof seriesNode === "object") {
                const u = seriesNode.url || seriesNode["@id"] || "";
                const m = /\/title\/(tt\d{7,})/i.exec(u);
                if (m) sid = m[1];
              }
              if (!sid) {
                const m = html.match(/href="\/title\/(tt\d{7,})\/[^"]*"\s*>\s*Series/i);
                if (m) sid = m[1];
              }
              if (sid) info.seriesId = sid;
            }
          }
        }
      } catch { /* continue */ }
    }

    // fallback to OG tags if needed
    if (!info.name) {
      const m = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
      if (m) info.name = m[1];
    }
    if (!info.poster) {
      const m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
      if (m) info.poster = m[1];
    }

  } catch { /* ignore */ }

  IMDB.set(imdbId, info);
  return info;
}

// ---------- CINEMETA ----------
async function fetchCinemeta(kind, imdbId) {
  const j = await fetchJson(`${CINEMETA}/meta/${encodeURIComponent(kind)}/${encodeURIComponent(imdbId)}.json`);
  return j && j.meta ? j.meta : null;
}
async function getBestMeta(imdbId) {
  if (BEST.has(imdbId)) return BEST.get(imdbId);
  // try movie first, then series (Cinemeta behavior is safe either way)
  let meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind: "movie", meta }; BEST.set(imdbId, rec); return rec; }
  meta = await fetchCinemeta("series", imdbId);
  if (meta) { const rec = { kind: "series", meta }; BEST.set(imdbId, rec); return rec; }

  // no Cinemeta → IMDb fallback for type/title/poster
  const fb = await fetchImdbFallback(imdbId);
  let kind = null;
  if (fb.type === "movie") kind = "movie";
  else if (fb.type === "series") kind = "series";
  else if (fb.type === "episode" && fb.seriesId) kind = "series";
  const rec = { kind, meta: null };
  BEST.set(imdbId, rec);
  return rec;
}

// ---------- BUILD CARD ----------
function cardFor(imdbId) {
  const best = BEST.get(imdbId) || { kind: null, meta: null };
  const fb = IMDB.get(imdbId) || {};
  const meta = best.meta;

  // choose type
  let type = best.kind;
  if (!type) {
    if (fb.type === "series" || (fb.type === "episode" && fb.seriesId)) type = "series";
    else type = "movie";
  }

  // choose name/poster
  const name = (meta && meta.name) || fb.name || imdbId;
  const poster = (meta && meta.poster) || fb.poster || undefined;

  // derive rating/runtime/year/releaseDate/description
  const imdbRating = meta ? (meta.imdbRating ?? meta.rating ?? undefined) : undefined;
  const runtime    = meta ? (meta.runtime ?? undefined) : (fb.duration ?? undefined);
  const year       = meta ? (meta.year ?? undefined)    : (fb.datePublished ? Number(String(fb.datePublished).slice(0,4)) : undefined);
  const releaseDate = meta
    ? (meta.releaseInfo ?? meta.released ?? undefined)
    : (fb.datePublished ?? undefined);
  const description = meta ? (meta.description || undefined) : undefined;

  return {
    id: imdbId,
    type,
    name,
    poster,
    background: meta?.background || undefined,
    logo: meta?.logo || undefined,
    imdbRating, runtime, year, releaseDate, description
  };
}

// ---------- SORTING ----------
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
    const na = (a == null), nb = (b == null);
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  return items
    .map((m, i) => ({ m, i }))
    .sort((A, B) => {
      const a = A.m, b = B.m;
      let c = 0;
      if (key === "date")    c = cmpNullBottom(toTs(a.releaseDate, a.year), toTs(b.releaseDate, b.year));
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

// ---------- SYNC ----------
async function fullSync() {
  if (SYNCING) return;
  SYNCING = true;
  try {
    let discovered = [];
    try { discovered = await discoverListsFromUserPage(IMDB_USER_URL); }
    catch (e) { console.warn("Discovery failed:", e.message); discovered = []; }

    const next = Object.create(null);
    const allIds = new Set();

    // fetch each list
    for (const L of discovered) {
      const rawIds = await fetchListIdsAllPages(L.url).catch(() => []);
      const ids = [];
      const seen = new Set();

      for (const tid of rawIds) {
        let tt = tid;
        // strong IMDb fallback for type/series mapping
        const fb = await fetchImdbFallback(tt);
        if (COLLAPSE_EPISODES && fb.type === "episode" && fb.seriesId) {
          EP_TO_SERIES.set(tt, fb.seriesId);
          tt = fb.seriesId;
        }
        if (!seen.has(tt)) { seen.add(tt); ids.push(tt); }
        allIds.add(tt);
      }

      next[L.name || L.id] = { url: L.url, ids };
    }

    // preload BEST from Cinemeta (both kinds via getBestMeta)
    await mapLimit(Array.from(allIds), 8, getBestMeta);

    // build fallback cards for any we haven’t touched yet (ensure IMDB fallback is in cache)
    await mapLimit(Array.from(allIds), 8, async (tt) => { if (!IMDB.has(tt)) await fetchImdbFallback(tt); });

    LISTS = next;
    LAST_SYNC_AT = Date.now();

    const count = Array.from(allIds).length;
    console.log(`[SYNC] ok – ${count} ids across ${Object.keys(LISTS).length} lists in 0 min`);
  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    SYNCING = false;
  }
}
function scheduleSync() {
  if (SYNC_TIMER) { clearTimeout(SYNC_TIMER); SYNC_TIMER = null; }
  if (IMDB_SYNC_MINUTES > 0) {
    SYNC_TIMER = setTimeout(async () => { await fullSync(); scheduleSync(); }, minToMs(IMDB_SYNC_MINUTES));
  }
}

// ---------- SERVER ----------
const app = express();
app.use((_, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });

function addonAllowed(req) {
  if (!SHARED_SECRET) return true;
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return u.searchParams.get("key") === SHARED_SECRET;
}
function adminAllowed(req) {
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return (u.searchParams.get("admin") || req.headers["x-admin-key"]) === ADMIN_PASSWORD;
}
function absBase(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

app.get("/health", (_, res) => res.status(200).send("ok"));

// manifest + catalogs
const baseManifest = {
  id: "org.mylists.imdb",
  name: "My Lists",
  version: "10.0.0",
  description: "Your IMDb lists as Stremio catalogs (titles cached; correct types & dates).",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  idPrefixes: ["tt"]
};
function catalogs() {
  return Object.keys(LISTS).map(name => ({
    type: "movie",   // Stremio ignores this for catalogs; we still expose both movie/series in metas
    id: `list:${name}`,
    name: `🗂 ${name}`,
    extraSupported: ["search","skip","limit","sort"],
    extra: [
      { name:"search" }, { name:"skip" }, { name:"limit" },
      { name:"sort", options:["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"] }
    ],
    posterShape: "poster"
  }));
}
app.get("/manifest.json", (req, res) => {
  if (!addonAllowed(req)) return res.status(403).send("Forbidden");
  res.setHeader("Cache-Control", "no-store");
  res.json({ ...baseManifest, catalogs: catalogs() });
});

// parse extras
function extrasFrom(req) {
  const params = new URLSearchParams(req.params.extra || "");
  const fromPath = Object.fromEntries(params.entries());
  return { ...fromPath, ...(req.query || {}) };
}

// catalog
app.get("/catalog/:t/:id/:extra?.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    const { id } = req.params;
    if (!id?.startsWith("list:")) return res.json({ metas: [] });
    const listName = id.slice(5);
    const list = LISTS[listName];
    if (!list) return res.json({ metas: [] });

    const extra = extrasFrom(req);
    const q     = String(extra.search || "").toLowerCase().trim();
    const sort  = String(extra.sort || "name_asc");

    // ensure BEST/IMDB cache exists (helps after cold boot)
    await mapLimit(list.ids, 8, async (tt) => {
      if (!BEST.has(tt)) await getBestMeta(tt);
      if (!IMDB.has(tt)) await fetchImdbFallback(tt);
    });

    let metas = list.ids.map(cardFor);

    if (q) {
      metas = metas.filter(m =>
        (m.name || "").toLowerCase().includes(q) ||
        (m.id || "").toLowerCase().includes(q) ||
        (m.description || "").toLowerCase().includes(q)
      );
    }

    metas = stableSort(metas, sort);

    const skip  = Math.max(0, Number(extra.skip || 0));
    const limit = Math.min(Number(extra.limit || 100), 200);
    res.json({ metas: metas.slice(skip, skip + limit) });
  } catch (e) {
    console.error("Catalog error:", e);
    res.status(500).send("Internal");
  }
});

// meta
app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    const imdbId = req.params.id;
    if (!isImdb(imdbId)) return res.json({ meta: { id: imdbId, type: "movie", name: imdbId } });

    // always try Cinemeta fresh (it may be available even if cache missed earlier)
    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);

    if (rec && rec.meta) {
      return res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind || rec.meta.type || "movie" } });
    }

    const fb = await fetchImdbFallback(imdbId);
    const kind = (fb.type === "series" || (fb.type === "episode" && fb.seriesId)) ? "series" : "movie";
    return res.json({
      meta: {
        id: imdbId,
        type: kind,
        name: fb.name || imdbId,
        poster: fb.poster || undefined,
        released: fb.datePublished || undefined,
        runtime: fb.duration || undefined
      }
    });
  } catch (e) {
    console.error("Meta error:", e);
    res.status(500).send("Internal");
  }
});

// admin
app.get("/admin", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");

  // rediscover lists to show in UI (non-blocking for cache)
  let disc = [];
  try { disc = await discoverListsFromUserPage(IMDB_USER_URL); } catch {}

  const manifestUrl = `${absBase(req)}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;
  const snapHtml = Object.keys(LISTS).length
    ? `<ul>${Object.entries(LISTS).map(([n, v]) => `<li><b>${n}</b> <small>(${(v.ids||[]).length} items)</small><br/><small>${v.url}</small></li>`).join("")}</ul>`
    : "<p>(none)</p>";

  const discHtml = disc.length
    ? `<ul>${disc.map(x => `<li><b>${x.name}</b><br/><small>${x.url}</small></li>`).join("")}</ul>`
    : `<p><small>${IMDB_USER_URL ? "No public lists found (or IMDb unreachable right now)." : "Set IMDB_USER_URL in your environment."}</small></p>`;

  res.type("html").send(`<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>My Lists – Admin</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:780px}
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
    ${snapHtml}
    <p><small>Last sync: ${LAST_SYNC_AT ? new Date(LAST_SYNC_AT).toLocaleString() : "never"}</small></p>
    <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}">
      <button class="btn2">Sync IMDb Lists Now</button>
    </form>
    <p><small>Auto-sync every ${IMDB_SYNC_MINUTES} min${IMDB_SYNC_MINUTES ? "" : " (disabled)"}.</small></p>
  </div>

  <div class="card">
    <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
    ${discHtml}
  </div>

  <div class="card">
    <h3>Manifest URL</h3>
    <p class="code">${manifestUrl}</p>
  </div>
</body></html>`);
});

app.post("/api/sync", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    await fullSync();
    scheduleSync();
    res.status(200).send(`Synced. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

// boot
(async () => {
  // initial sync (non-blocking)
  fullSync().then(() => scheduleSync());
  app.listen(PORT, HOST, () => {
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
  });
})();
