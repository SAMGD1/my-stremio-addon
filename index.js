/*  My Lists – IMDb → Cinemeta snapshot add-on
 *  v9.1 – instant catalogs from a preloaded snapshot
 *  - Auto-sync every IMDB_SYNC_MINUTES (default 60)
 *  - Force sync from /admin
 *  - Cinemeta posters/titles first; IMDb title-page fallback (no TT placeholders)
 *  - Manifest auto-bump when list set changes (no reinstall)
 *  - Optional GitHub snapshot persistence for fast cold starts
 */

const express = require("express");

// ----------------- ENV -----------------
const PORT = Number(process.env.PORT) || 7000;
const HOST = "0.0.0.0";

const SHARED_SECRET  = process.env.SHARED_SECRET  || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/urXXXX/lists/
const IMDB_LISTS_JSON   = process.env.IMDB_LISTS || "[]";  // optional whitelist: [{"name":"Marvel Movies","url":"https://www.imdb.com/list/ls.../"}]
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

const GITHUB_TOKEN   = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER   = process.env.GITHUB_OWNER || "";
const GITHUB_REPO    = process.env.GITHUB_REPO  || "";
const SNAPSHOT_BRANCH= process.env.SNAPSHOT_BRANCH || "main";
const SNAPSHOT_DIR   = process.env.SNAPSHOT_DIR || "snapshot";

// ----------------- CONSTANTS -----------------
const CINEMETA = "https://v3-cinemeta.strem.io";
const SNAPSHOT_FILE = `${SNAPSHOT_DIR}/snapshot.json`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/9.1";

// ----------------- STATE -----------------
// lists: { [name]: { url, ids: [ 'tt...' ] } }
let LISTS = Object.create(null);

// fallback for titles/posters if Cinemeta doesn't have them
// Map<tt, { name?:string, poster?:string }>
const FALLBACK = new Map();

// Best Cinemeta meta cache
// Map<tt, {kind:'movie'|'series'|null, meta:object|null}>
const BEST = new Map();

// Prebuilt cards for catalogs (instant)
// Map<tt, { id, type, name, poster, background, logo, imdbRating, runtime, year, releaseDate, description }>
const CARDS = new Map();

let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;

// manifest rev increments if list set changes
let MANIFEST_REV = 1;
let LAST_LISTS_KEY = "";

// ----------------- UTILS -----------------
function isImdb(v) { return /^tt\d{7,}$/i.test(String(v || "")); }
function nowIso()  { return new Date().toISOString(); }
function minToMs(m) { return m * 60 * 1000; }
function listsKey() { return JSON.stringify(Object.keys(LISTS).sort()); }

async function fetchText(url, accept) {
  const headers = { "User-Agent": UA };
  if (accept) headers["Accept"] = accept;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}
function withParam(url, key, val) {
  const u = new URL(url);
  u.searchParams.set(key, val);
  return u.toString();
}

// ----------------- GITHUB SNAPSHOT (optional) -----------------
const GH_ENABLED = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

async function ghRequest(method, path, bodyObj) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": UA
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`GitHub ${method} ${path} -> ${r.status}: ${t}`);
  }
  return r.json();
}
async function ghGetSha(path) {
  try {
    const data = await ghRequest("GET", `/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(SNAPSHOT_BRANCH)}`);
    return data && data.sha || null;
  } catch (_) { return null; }
}
async function ghWriteSnapshot(obj) {
  if (!GH_ENABLED) return;
  const content = Buffer.from(JSON.stringify(obj, null, 2)).toString("base64");
  const sha = await ghGetSha(SNAPSHOT_FILE);
  const body = { message: "Update snapshot.json", content, branch: SNAPSHOT_BRANCH };
  if (sha) body.sha = sha;
  await ghRequest("PUT", `/contents/${encodeURIComponent(SNAPSHOT_FILE)}`, body);
}
async function ghReadSnapshot() {
  if (!GH_ENABLED) return null;
  try {
    const data = await ghRequest("GET", `/contents/${encodeURIComponent(SNAPSHOT_FILE)}?ref=${encodeURIComponent(SNAPSHOT_BRANCH)}`);
    if (!data || !data.content) return null;
    const buf = Buffer.from(data.content, "base64").toString("utf8");
    return JSON.parse(buf);
  } catch (_) { return null; }
}

// ----------------- IMDb DISCOVERY -----------------
function parseImdbListsEnv() {
  try {
    const arr = JSON.parse(IMDB_LISTS_JSON);
    if (Array.isArray(arr) && arr.length) return arr.map(x => ({ name: x.name, url: x.url }));
  } catch(_) {}
  return [];
}
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const u = new URL(userListsUrl);
  u.searchParams.set("_", Date.now().toString());
  const html = await fetchText(u.toString(), "text/html");
  // capture only /list/ls... cards/links
  const map = new Map();
  // Common link for list title:
  const re = /<a[^>]+href="\/list\/(ls\d{6,})\/"[^>]*>(.*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const raw = m[2].replace(/<[^>]+>/g, "");
    const name = raw.replace(/\s+/g, " ").trim();
    if (!map.has(id) && name) map.set(id, { name, url: `https://www.imdb.com/list/${id}/` });
  }
  return Array.from(map.values());
}

// ----------------- IMDb LIST PARSER (robust) -----------------
function extractBlock(html) {
  // Try multiple containers; fallback to whole html if nothing matches
  const tries = [
    /<div[^>]+class="[^"]*\blister-list\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<ul[^>]+class="[^"]*\bipc-metadata-list\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i,
    /<section[^>]+data-testid="[^"]*list[^"]*"[^>]*>([\s\S]*?)<\/section>/i
  ];
  for (let i=0;i<tries.length;i++) {
    const m = html.match(tries[i]);
    if (m && m[1]) return m[1];
  }
  return html; // best effort
}
function idsAndTitlesFromHtmlStrict(html) {
  const scoped = extractBlock(html);
  const found = new Map();
  let m;

  // 1) data-tconst (grid/new UI)
  const reData = /data-tconst="(tt\d{7,})"/gi;
  while ((m = reData.exec(scoped))) {
    const tt = m[1];
    if (!found.has(tt)) found.set(tt, { id: tt });
  }

  // 2) lister-item blocks (classic detail)
  const reLister = /<div[^>]+class="[^"]*\blister-item\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  while ((m = reLister.exec(scoped))) {
    const block = m[1];
    const m2 = block.match(/href="\/title\/(tt\d{7,})\//i);
    if (m2) {
      const tt = m2[1];
      const t = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*>(.*?)<\/a>/i);
      const title = t ? t[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
      const img = block.match(/<img[^>]+(?:loadlate|src)="([^"]+)"[^>]*>/i);
      const poster = img ? img[1] : "";
      const prev = found.get(tt) || { id: tt };
      if (title && !prev.name) prev.name = title;
      if (poster && !prev.poster) prev.poster = poster;
      found.set(tt, prev);
    }
  }

  // 3) summary items (new UI)
  const reSumm = /<li[^>]+class="[^"]*\bipc-metadata-list-summary-item\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  while ((m = reSumm.exec(scoped))) {
    const block = m[1];
    const m2 = block.match(/href="\/title\/(tt\d{7,})\//i);
    if (m2) {
      const tt = m2[1];
      const t = block.match(/<a[^>]*>(.*?)<\/a>/i);
      const title = t ? t[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
      const img = block.match(/<img[^>]+alt="([^"]+)"[^>]*?(?:loadlate|src)="([^"]+)"/i);
      const altTitle = img ? img[1] : "";
      const poster = img ? img[2] : "";
      const name = title || altTitle;
      const prev = found.get(tt) || { id: tt };
      if (name && !prev.name) prev.name = name;
      if (poster && !prev.poster) prev.poster = poster;
      found.set(tt, prev);
    }
  }

  // 4) fallback inside scoped only: any /title/ links + nearby anchor text
  const reAny = /<a[^>]+href="\/title\/(tt\d{7,})\/[^"]*"[^>]*>(.*?)<\/a>/gi;
  while ((m = reAny.exec(scoped))) {
    const tt = m[1];
    const maybe = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const prev = found.get(tt) || { id: tt };
    if (maybe && !prev.name) prev.name = maybe;
    found.set(tt, prev);
  }

  return Array.from(found.values());
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
  // try multiple modes and paginate
  const modes = ["detail", "grid", "compact"];
  const seen = new Set();
  const items = [];

  for (let i=0;i<modes.length;i++) {
    let url = withParam(listUrl, "mode", modes[i]);
    let pages = 0;
    while (url && pages < 50) {
      let html;
      try { html = await fetchText(withParam(url, "_", Date.now().toString()), "text/html"); }
      catch(_) { break; }
      const found = idsAndTitlesFromHtmlStrict(html);
      let added = 0;
      for (let j=0;j<found.length;j++) {
        const tt = found[j].id;
        if (!isImdb(tt) || seen.has(tt)) continue;
        seen.add(tt); added++;
        if ((found[j].name || found[j].poster) && !FALLBACK.has(tt)) {
          FALLBACK.set(tt, { name: found[j].name || undefined, poster: found[j].poster || undefined });
        }
        items.push({ id: tt });
      }
      pages++;
      const nextUrl = findNextLink(html);
      if (!nextUrl || added === 0) break;
      url = nextUrl;
    }
    if (items.length) break; // success
  }
  return items;
}

// ----------------- Strong IMDb title-page fallback -----------------
async function fetchImdbTitleFallback(tt) {
  try {
    const html = await fetchText(`https://www.imdb.com/title/${tt}/`, "text/html");

    // JSON-LD first
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        const node = Array.isArray(j && j["@graph"]) ? j["@graph"][0] : j;
        let name = null, image = null;
        if (node && typeof node === "object") {
          if (typeof node.name === "string") name = node.name;
          if (typeof node.headline === "string" && !name) name = node.headline;
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
      headers: { "User-Agent": UA, "Accept": "application/json" }
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

// Build a “card” for catalogs from BEST + FALLBACK
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
      try { cfg = await discoverListsFromUser(IMDB_USER_URL); }
      catch(e) { console.warn("IMDb discovery failed:", e.message); cfg = []; }
    }

    // fetch items for each list
    const nextLISTS = Object.create(null);
    const allIdsSet = new Set();

    for (let i=0;i<cfg.length;i++) {
      const L = cfg[i];
      let items = [];
      try { items = await fetchImdbListItems(L.url); }
      catch(e) { console.warn("Fetch list failed:", L.name, e.message); }
      nextLISTS[L.name] = { url: L.url, ids: items.map(x => x.id) };
      for (let j=0;j<items.length;j++) allIdsSet.add(items[j].id);
    }

    // preload Cinemeta (both types) for all unique ids
    const idsAll = Array.from(allIdsSet);
    await mapLimit(idsAll, 8, async (tt) => { if (isImdb(tt)) await getBestMeta(tt); });

    // build cards snapshot, then backfill any weak bits from IMDb title page
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

    // version bump if list set changed (so Stremio updates catalogs without reinstall)
    const key = listsKey();
    if (key !== LAST_LISTS_KEY) {
      LAST_LISTS_KEY = key;
      MANIFEST_REV++;
      console.log("[SYNC] catalogs changed → manifest rev", MANIFEST_REV);
    }

    LAST_SYNC_AT = Date.now();
    console.log(`[SYNC] ${idsAll.length} ids across ${Object.keys(LISTS).length} lists`);

    // persist snapshot to GitHub (optional)
    const snap = {
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      fallback: Object.fromEntries(Array.from(FALLBACK.entries())), // { tt: {name,poster}, ... }
      cards: Object.fromEntries(Array.from(CARDS.entries()))        // { tt: card, ... }
    };
    if (GH_ENABLED) {
      try { await ghWriteSnapshot(snap); console.log("[SYNC] snapshot saved to GitHub"); }
      catch(e) { console.warn("[SYNC] failed to save snapshot:", e.message); }
    }
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
async function loadSnapshotFromGitHubAtBoot() {
  if (!GH_ENABLED) return false;
  const obj = await ghReadSnapshot();
  if (!obj) return false;
  try {
    LISTS = obj.lists || Object.create(null);
    FALLBACK.clear();
    if (obj.fallback) {
      const entries = Object.keys(obj.fallback);
      for (let i=0;i<entries.length;i++) {
        const tt = entries[i];
        const v = obj.fallback[tt] || {};
        FALLBACK.set(tt, { name: v.name, poster: v.poster });
      }
    }
    CARDS.clear();
    if (obj.cards) {
      const entries = Object.keys(obj.cards);
      for (let i=0;i<entries.length;i++) {
        const tt = entries[i];
        CARDS.set(tt, obj.cards[tt]);
      }
    }
    MANIFEST_REV = obj.manifestRev || 1;
    LAST_SYNC_AT = obj.lastSyncAt || 0;
    LAST_LISTS_KEY = listsKey();
    console.log("[BOOT] snapshot loaded from GitHub");
    return true;
  } catch(e) {
    console.warn("[BOOT] invalid snapshot:", e.message);
    return false;
  }
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

// ---- Manifest (no-cache; auto-version bump) ----
const baseManifest = {
  id: "org.my.csvlists",
  version: "9.1.0",
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

// ---- Catalog (instant, from CARDS) ----
app.get("/catalog/:type/:id/:extra?.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    res.setHeader("Cache-Control", "no-store");

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

// ---- Meta (use preloaded Cinemeta; fallback to minimal) ----
app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    res.setHeader("Cache-Control", "no-store");
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

  const manifestUrl = `${absoluteBase(req)}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;
  const names = Object.keys(LISTS);
  const listHtml = names.length
    ? `<ul>${names.map(n => `<li><b>${n}</b> <small>(${(LISTS[n].ids||[]).length} items)</small><br/><small>${LISTS[n].url || ""}</small></li>`).join("")}</ul>`
    : "<p>(no lists yet)</p>";

  let discoveredHtml = "<p><small>Set IMDB_USER_URL or IMDB_LISTS to discover your lists.</small></p>";
  if (IMDB_USER_URL) {
    try {
      const discovered = await discoverListsFromUser(IMDB_USER_URL);
      discoveredHtml = discovered.length
        ? `<ul>${discovered.map(x => `<li><b>${x.name}</b><br/><small>${x.url}</small></li>`).join("")}</ul>`
        : "<p><small>No public lists found (or IMDb temporarily unreachable).</small></p>";
    } catch (_) {}
  }

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
    <p><small>Snapshot persistence: ${GH_ENABLED ? "GitHub enabled" : "disabled"}</small></p>
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

// ----------------- BOOT -----------------
(async () => {
  // Try loading a persisted snapshot so catalogs work instantly after cold start
  const ok = await loadSnapshotFromGitHubAtBoot();
  if (!ok) console.log("[BOOT] no snapshot/persistence; catalogs will populate after first sync");

  // Initial sync (non-blocking)
  fullSync({ rediscover: true }).then(() => scheduleNextSync(false));

  const app = express();
})();
