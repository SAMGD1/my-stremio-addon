/* My Lists – IMDb → Stremio Add-on
 * - Auto-discovers ALL public lists from IMDB_USER_URL
 * - Crawls every page (detail/grid/compact) so you get ALL items (not just 25)
 * - Cinemeta-first metadata with IMDb title-page fallback for name/poster
 * - In-memory snapshot for instant catalogs + admin force-sync
 */

const express = require("express");

// ----------------- ENV -----------------
const PORT = Number(process.env.PORT) || 7000;
const HOST = "0.0.0.0";

const SHARED_SECRET  = process.env.SHARED_SECRET  || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/urXXXX/lists/
const IMDB_LISTS_JSON   = process.env.IMDB_LISTS || "[]";  // optional whitelist: [{"name":"X","url":"https://..."}]
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

const CINEMETA = "https://v3-cinemeta.strem.io";

// ----------------- STATE -----------------
// lists: { [name]: { url, ids: [ 'tt...' ] } }
let LISTS = Object.create(null);

// Best Cinemeta meta cache
// Map<tt, {kind:'movie'|'series'|null, meta:object|null}>
const BEST = new Map();

// Fallback for titles/posters if Cinemeta doesn't have them
// Map<tt, { name?:string, poster?:string }>
const FALLBACK = new Map();

// Prebuilt cards for catalogs (instant)
// Map<tt, { id, type, name, poster, background, logo, imdbRating, runtime, year, releaseDate, description }>
const CARDS = new Map();

let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;

// manifest rev increments if list set changes (so Stremio refreshes without reinstall)
let MANIFEST_REV = 1;
let LAST_LISTS_KEY = "";

// ----------------- UTILS -----------------
function isImdb(v) { return /^tt\d{7,}$/i.test(String(v || "")); }
function nowIso()  { return new Date().toISOString(); }
function minToMs(m) { return m * 60 * 1000; }
function listsKey() { return JSON.stringify(Object.keys(LISTS).sort()); }

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache"
};

async function fetchText(url) {
  const r = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}

// ----------------- IMDb LIST DISCOVERY -----------------
function parseImdbListsEnv() {
  try {
    const arr = JSON.parse(IMDB_LISTS_JSON);
    if (Array.isArray(arr) && arr.length) return arr.map(x => ({ name: x.name, url: x.url }));
  } catch(_) {}
  return [];
}

async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const url = new URL(userListsUrl);
  url.search = ""; // keep it clean

  const html = await fetchText(url.toString());

  const foundIds = new Set();
  // 1) Absolute links
  for (const m of html.matchAll(/https:\/\/www\.imdb\.com\/list\/(ls\d{6,})\//gi)) foundIds.add(m[1]);
  // 2) Relative links
  for (const m of html.matchAll(/href="\/list\/(ls\d{6,})\/"/gi)) foundIds.add(m[1]);
  // 3) data-list-id attributes
  for (const m of html.matchAll(/data-list-id="(ls\d{6,})"/gi)) foundIds.add(m[1]);
  // 4) Any ls########## token (fallback in case markup is React/JSON only)
  for (const m of html.matchAll(/\b(ls\d{6,})\b/gi)) foundIds.add(m[1]);

  function findNameNear(id) {
    const re = new RegExp(`<a[^>]+href="\\/list\\/${id}\\/[^"]*"[^>]*>([\\s\\S]*?)<\\/a>`, "i");
    const viaA = html.match(re);
    if (viaA) {
      const t = viaA[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (t) return t;
    }
    // try a nearby heading
    const reH = new RegExp(`(<h[1-6][^>]*>[\\s\\S]*?<\\/h[1-6]>)\\s*[\\s\\S]{0,200}?\\/list\\/${id}\\/`, "i");
    const viaH = html.match(reH);
    if (viaH) {
      const t = viaH[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (t) return t;
    }
    return id;
  }

  const lists = [];
  for (const id of foundIds) {
    lists.push({ name: findNameNear(id), url: `https://www.imdb.com/list/${id}/` });
  }

  // de-dup by URL
  const uniq = new Map();
  lists.forEach(x => { if (!uniq.has(x.url)) uniq.set(x.url, x); });
  return Array.from(uniq.values());
}

// ----------------- IMDb LIST ITEMS (robust) -----------------
function extractListBlock(html) {
  const tries = [
    /<div[^>]+class="[^"]*\blister-list\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i, // (typo-safe)
    /<div[^>]+class="[^"]*\blister\b[^"]*list[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class="[^"]*\bl?ister-list\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<ul[^>]+class="[^"]*\blister-list\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i,   // classic
    /<ul[^>]+class="[^"]*\bipc-metadata-list\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i, // grid
    /<section[^>]+data-testid="[^"]*list[^"]*"[^>]*>([\s\S]*?)<\/section>/i
  ];
  for (let i=0;i<tries.length;i++) {
    const m = html.match(tries[i]);
    if (m && m[1]) return m[1];
  }
  return html; // fallback
}

function extractNearbyTitlePoster(html, idx) {
  const start = Math.max(0, idx - 800);
  const end   = Math.min(html.length, idx + 800);
  const chunk = html.slice(start, end);
  const img = chunk.match(/<img[^>]+alt="([^"]+)"[^>]*?(?:loadlate|src)="([^"]+)"/i);
  const a = chunk.match(/<a[^>]*>([^<]+)<\/a>/i);
  const name = img ? img[1] : (a ? a[1] : "");
  const poster = img ? img[2] : "";
  return {
    name: (name || "").replace(/\s+/g, " ").trim(),
    poster: poster || ""
  };
}

function idsAndFallbacksFromHtml(html) {
  const scoped = extractListBlock(html);
  const seen = new Set();
  const out = [];

  // Find by data-tconst first
  for (const m of scoped.matchAll(/data-tconst="(tt\d{7,})"/gi)) {
    const tt = m[1];
    if (!seen.has(tt)) {
      seen.add(tt);
      const near = extractNearbyTitlePoster(scoped, m.index || 0);
      out.push({ id: tt, name: near.name, poster: near.poster });
    }
  }
  // Also capture any /title/ links within scoped block
  for (const m of scoped.matchAll(/href="\/title\/(tt\d{7,})\//gi)) {
    const tt = m[1];
    if (!seen.has(tt)) {
      seen.add(tt);
      const near = extractNearbyTitlePoster(scoped, m.index || 0);
      out.push({ id: tt, name: near.name, poster: near.poster });
    }
  }
  return out;
}

function findNextLink(html) {
  let m = html.match(/<a[^>]+rel="next"[^>]+href="([^"]+)"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*lister-page-next[^"]*"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*data-testid="pagination-next-page-button"[^>]*>/i);
  if (!m) return null;
  try { return new URL(m[1], "https://www.imdb.com").toString(); }
  catch { return null; }
}

async function fetchImdbListItems(listUrl) {
  // Try detail, grid, compact; follow "next page"
  const modes = ["detail", "grid", "compact"];
  const seen = new Set();
  const items = [];

  for (let i=0;i<modes.length;i++) {
    let url = new URL(listUrl);
    url.searchParams.set("mode", modes[i]);
    let pages = 0;

    while (url && pages < 50) {
      const html = await fetchText(url.toString()).catch(() => "");
      if (!html) break;

      const found = idsAndFallbacksFromHtml(html);
      let added = 0;
      for (let j=0;j<found.length;j++) {
        const tt = found[j].id;
        if (!isImdb(tt) || seen.has(tt)) continue;
        seen.add(tt); added++;
        // store quick fallbacks if present
        if ((found[j].name || found[j].poster) && !FALLBACK.has(tt)) {
          FALLBACK.set(tt, {
            name: found[j].name || undefined,
            poster: found[j].poster || undefined
          });
        }
        items.push({ id: tt });
      }

      const nextUrl = findNextLink(html);
      pages++;
      if (!nextUrl || added === 0) break;
      url = new URL(nextUrl);
    }

    if (items.length) break; // mode succeeded
  }
  return items;
}

// ----------------- IMDb title-page fallback (name/poster) -----------------
async function fetchImdbTitleFallback(tt) {
  try {
    const html = await fetchText(`https://www.imdb.com/title/${tt}/`);
    // JSON-LD
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        const node = Array.isArray(j && j["@graph"]) ? j["@graph"][0] : j;
        let name = null, image = null;
        if (node && typeof node === "object") {
          if (typeof node.name === "string") name = node.name;
          if (!name && typeof node.headline === "string") name = node.headline;
          if (typeof node.image === "string") image = node.image;
          else if (node.image && typeof node.image.url === "string") image = node.image.url;
        }
        if (name || image) return { name: name || null, poster: image || null };
      } catch (_) { /* continue to OG */ }
    }
    // OpenGraph fallback
    const t = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    const p = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    return { name: t ? t[1] : null, poster: p ? p[1] : null };
  } catch (_) {
    return { name: null, poster: null };
  }
}

// ----------------- Cinemeta -----------------
async function fetchCinemeta(kind, imdbId) {
  try {
    const r = await fetch(`${CINEMETA}/meta/${encodeURIComponent(kind)}/${encodeURIComponent(imdbId)}.json`, {
      headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"], "Accept": "application/json" }
    });
    if (!r.ok) return null;
    const obj = await r.json();
    return obj && obj.meta ? obj.meta : null;
  } catch(_) { return null; }
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

// Build a catalog card from BEST + FALLBACK; guarantee a name/poster when possible
function buildCard(tt) {
  const rec = BEST.get(tt) || { kind: null, meta: null };
  const meta = rec.meta || null;
  const fb = FALLBACK.get(tt) || {};
  const nameFromMeta = meta && typeof meta.name === "string" ? meta.name : null;
  const posterFromMeta = meta && typeof meta.poster === "string" ? meta.poster : null;
  const backgroundFromMeta = meta && typeof meta.background === "string" ? meta.background : null;
  const logoFromMeta = meta && typeof meta.logo === "string" ? meta.logo : null;
  const imdbRatingFromMeta =
    meta && (meta.imdbRating !== undefined ? meta.imdbRating : (meta.rating !== undefined ? meta.rating : null));
  const runtimeFromMeta = meta && meta.runtime !== undefined ? meta.runtime : null;
  const yearFromMeta = meta && meta.year !== undefined ? meta.year : null;
  const releaseFromMeta =
    meta && (meta.releaseInfo !== undefined ? meta.releaseInfo : (meta.released !== undefined ? meta.released : null));
  const descFromMeta = meta && typeof meta.description === "string" ? meta.description : null;

  const card = {
    id: tt,
    type: rec.kind || "movie",
    name: nameFromMeta || fb.name || tt,
    poster: posterFromMeta || fb.poster || undefined,
    background: backgroundFromMeta || undefined,
    logo: logoFromMeta || undefined,
    imdbRating: imdbRatingFromMeta !== null ? imdbRatingFromMeta : undefined,
    runtime: runtimeFromMeta !== null ? runtimeFromMeta : undefined,
    year: yearFromMeta !== null ? yearFromMeta : undefined,
    releaseDate: releaseFromMeta !== null ? releaseFromMeta : undefined,
    description: descFromMeta || undefined
  };
  return card;
}

// ----------------- Sorting -----------------
function toTs(dateStr, year) {
  if (dateStr) {
    const n = Date.parse(dateStr);
    if (!Number.isNaN(n)) return n;
  }
  if (year) {
    const n = Date.parse(String(year) + "-01-01");
    if (!Number.isNaN(n)) return n;
  }
  return null;
}
function stableSort(items, sortKey) {
  const s = String(sortKey || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const key = s.split("_")[0];

  function cmpNullBottom(a, b) {
    const na = (a === null || a === undefined);
    const nb = (b === null || b === undefined);
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
      if (key === "date") c = cmpNullBottom(toTs(a.releaseDate, a.year), toTs(b.releaseDate, b.year));
      else if (key === "rating") c = cmpNullBottom(a.imdbRating, b.imdbRating);
      else if (key === "runtime") c = cmpNullBottom(a.runtime, b.runtime);
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

// ----------------- SYNC -----------------
async function fullSync({ rediscover = true } = {}) {
  if (syncInProgress) return;
  syncInProgress = true;
  try {
    // discover lists
    let cfg = parseImdbListsEnv();
    if ((!cfg || cfg.length === 0) && (IMDB_USER_URL && rediscover)) {
      try {
        cfg = await discoverListsFromUser(IMDB_USER_URL);
      } catch(e) {
        console.warn("IMDb discovery failed:", e.message);
        cfg = [];
      }
    }

    const nextLISTS = Object.create(null);
    const allIdsSet = new Set();

    for (let i=0;i<cfg.length;i++) {
      const L = cfg[i];
      let items = [];
      try {
        items = await fetchImdbListItems(L.url);
      } catch(e) {
        console.warn("Fetch list failed:", L.name, e.message);
      }
      nextLISTS[L.name] = { url: L.url, ids: items.map(x => x.id) };
      for (let j=0;j<items.length;j++) allIdsSet.add(items[j].id);
    }

    // preload Cinemeta (both types) for all unique ids
    const idsAll = Array.from(allIdsSet);
    await mapLimit(idsAll, 8, async (tt) => { if (isImdb(tt)) await getBestMeta(tt); });

    // build cards; fill weak ones with IMDb title page
    CARDS.clear();
    await mapLimit(idsAll, 6, async (tt) => {
      let card = buildCard(tt);
      const weakName = !card.name || /^tt\d{7,}$/i.test(card.name);
      const weakPoster = !card.poster;

      if (weakName || weakPoster) {
        const fb = await fetchImdbTitleFallback(tt);
        if (fb.name && weakName) card.name = fb.name;
        if (fb.poster && weakPoster) card.poster = fb.poster;

        const prev = FALLBACK.get(tt) || {};
        FALLBACK.set(tt, { name: card.name || prev.name || undefined, poster: card.poster || prev.poster || undefined });
      }
      CARDS.set(tt, card);
    });

    LISTS = nextLISTS;

    const key = listsKey();
    if (key !== LAST_LISTS_KEY) {
      LAST_LISTS_KEY = key;
      MANIFEST_REV++;
      console.log("[SYNC] catalogs changed → manifest rev", MANIFEST_REV);
    }

    LAST_SYNC_AT = Date.now();
    console.log(`[SYNC] ok – ${idsAll.length} ids across ${Object.keys(LISTS).length} lists in 0 min`);
  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    syncInProgress = false;
  }
}
function scheduleNextSync(reset) {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  if (IMDB_SYNC_MINUTES <= 0) return;
  const delay = minToMs(IMDB_SYNC_MINUTES);
  syncTimer = setTimeout(async () => {
    await fullSync({ rediscover: true });
    scheduleNextSync(true);
  }, reset ? delay : delay);
}

// If Render sleeps a while, trigger a refresh on first request
function maybeBackgroundSync() {
  if (IMDB_SYNC_MINUTES <= 0) return;
  const tooOld = Date.now() - LAST_SYNC_AT > minToMs(IMDB_SYNC_MINUTES);
  if (tooOld && !syncInProgress) fullSync({ rediscover: true }).then(() => scheduleNextSync(true));
}

// ----------------- SERVER -----------------
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

// ---- Manifest ----
const baseManifest = {
  id: "org.my.csvlists",
  version: "10.0.0",
  name: "My Lists",
  description: "Your IMDb lists as instant catalogs; opens real pages so streams load.",
  resources: ["catalog", "meta"],
  types: ["my lists", "movie", "series"],
  idPrefixes: ["tt"]
};
function catalogs() {
  const names = Object.keys(LISTS);
  return names.map((name) => ({
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
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    const version = baseManifest.version + "." + MANIFEST_REV;
    res.json({ ...baseManifest, version, catalogs: catalogs() });
  } catch (e) {
    console.error("Manifest error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ---- helpers ----
function parseExtra(extraStr, queryObj) {
  const params = new URLSearchParams(extraStr || "");
  const fromPath = Object.fromEntries(params.entries());
  return { ...fromPath, ...(queryObj || {}) };
}

// ---- Catalog ----
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

    let metas = list.ids.map((tt) => {
      const c = CARDS.get(tt);
      if (c) return c;
      const fb = FALLBACK.get(tt) || {};
      return { id: tt, type: "movie", name: fb.name || tt, poster: fb.poster || undefined };
    });

    if (q) {
      metas = metas.filter(m =>
        (m.name || "").toLowerCase().includes(q) ||
        (m.description || "").toLowerCase().includes(q) ||
        (m.id || "").toLowerCase().includes(q)
      );
    }

    metas = stableSort(metas, sort);
    const page = metas.slice(skip, skip + limit);
    res.json({ metas: page });
  } catch (e) {
    console.error("Catalog error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ---- Meta ----
app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const imdbId = req.params.id;
    if (!isImdb(imdbId))
      return res.json({ meta: { id: imdbId, type: "movie", name: "Unknown item" } });

    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);

    if (!rec || !rec.meta) {
      const fb = FALLBACK.get(imdbId) || {};
      return res.json({ meta: { id: imdbId, type: (rec && rec.kind) ? rec.kind : "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
    }
    return res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
  } catch (e) {
    console.error("Meta error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ---- Admin ----
app.get("/admin", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");

  let discoveredHtml = "<p><small>Set IMDB_USER_URL to auto-discover your lists.</small></p>";
  if (IMDB_USER_URL) {
    try {
      const discovered = await discoverListsFromUser(IMDB_USER_URL);
      discoveredHtml = discovered.length
        ? `<ul>${discovered.map(x => `<li><b>${x.name}</b><br/><small>${x.url}</small></li>`).join("")}</ul>`
        : "<p><small>No public lists found (or IMDb temporarily unreachable right now).</small></p>";
    } catch (_) {}
  }

  const manifestUrl = `${absoluteBase(req)}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;
  const names = Object.keys(LISTS);
  const listHtml = names.length
    ? `<ul>${names.map(n => `<li><b>${n}</b> <small>(${(LISTS[n].ids||[]).length} items)</small><br/><small>${LISTS[n].url || ""}</small></li>`).join("")}</ul>`
    : "<ul><li>(none)</li></ul>";

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

// ----------------- BOOT ------------------
//-----
//----
fullSync({ rediscover: true }).then(() => scheduleNextSync(false));

app.listen(PORT, HOST, () => {
  console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
});
