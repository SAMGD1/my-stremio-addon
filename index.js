/* My Lists – IMDb → Stremio (stable build)
 * - Strict semver so Stremio installs (10.0.0)
 * - Robust IMDb discovery from user lists page
 * - Paginates every list, de-dupes; optional episode→series upgrade
 * - Metadata: Cinemeta → IMDb JSON-LD/OG fallback
 * - Admin UI: enable/disable, order, default list, per-list default sort
 */

const express = require("express");

// ---------- ENV ----------
const PORT  = Number(process.env.PORT || 7000);
const HOST  = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

// Optional GitHub snapshot/prefs persistence (safe if missing)
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || "";
const GITHUB_OWNER  = process.env.GITHUB_OWNER  || "";
const GITHUB_REPO   = process.env.GITHUB_REPO   || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const SNAPSHOT_DIR  = process.env.CSV_DIR       || "data";
const SNAPSHOT_FILE = `${SNAPSHOT_DIR}/snapshot.json`;
const GH_ENABLED = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

// ---------- CONST ----------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Stremio-MyLists/10.0";
const CINEMETA = "https://v3-cinemeta.strem.io";

// ---------- STATE ----------
let LISTS = Object.create(null);   // { lsid: { id, name, url, ids:[tt...] } }
let PREFS = {
  enabled: [],         // enabled lsids; [] = all
  order: [],           // ordering of lsids
  defaultList: "",     // lsid opened by default
  perListSort: {},     // { lsid: "date_desc" | ... }
  upgradeEpisodes: true
};
const BEST = new Map();   // Map<tt, {kind:'movie'|'series'|null, meta:object|null}>
const FALLBK = new Map(); // Map<tt, fallback minimal meta>
const EP2SER = new Map(); // Map<episode_tt, series_tt>
const CARD = new Map();   // Map<tt, catalog card>

let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;

// ---------- UTILS ----------
const isImdb = v => /^tt\d{7,}$/i.test(String(v || ""));
const isListId = v => /^ls\d{6,}$/i.test(String(v || ""));
const nowIso = () => new Date().toISOString();
const minToMs = m => m * 60 * 1000;

async function fetchText(url, accept) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": accept || "text/html,*/*" } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}
function withParam(url, key, val) { const u = new URL(url); u.searchParams.set(key, val); return u.toString(); }

// ---------- GITHUB (optional) ----------
async function gh(method, path, bodyObj) {
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
  if (!r.ok) throw new Error(`GitHub ${method} ${path} -> ${r.status} ${await r.text().catch(()=> "")}`);
  return r.json();
}
async function ghGetSha(path) {
  try {
    const data = await gh("GET", `/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    return data && data.sha || null;
  } catch { return null; }
}
async function ghWriteSnapshot(obj) {
  if (!GH_ENABLED) return;
  const content = Buffer.from(JSON.stringify(obj, null, 2)).toString("base64");
  const sha = await ghGetSha(SNAPSHOT_FILE);
  const body = { message: "Update snapshot.json", content, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  await gh("PUT", `/contents/${encodeURIComponent(SNAPSHOT_FILE)}`, body);
}
async function ghReadSnapshot() {
  if (!GH_ENABLED) return null;
  try {
    const data = await gh("GET", `/contents/${encodeURIComponent(SNAPSHOT_FILE)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    const buf = Buffer.from(data.content, "base64").toString("utf8");
    return JSON.parse(buf);
  } catch { return null; }
}

// ---------- IMDb DISCOVERY ----------
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(withParam(userListsUrl, "_", Date.now()), "text/html");

  // Super-robust: collect any ls########## we see
  const ids = Array.from(new Set((html.match(/ls\d{6,}/g) || [])));

  const arr = ids.map(id => ({ id, url: `https://www.imdb.com/list/${id}/` }));
  // resolve names
  await Promise.all(arr.map(async L => {
    try { L.name = await fetchListName(L.url); } catch { L.name = L.id; }
  }));
  return arr;
}

async function fetchListName(listUrl) {
  const html = await fetchText(withParam(listUrl, "_", Date.now()), "text/html");
  const tries = [
    /<h1[^>]+data-testid="list-header-title"[^>]*>(.*?)<\/h1>/i,
    /<h1[^>]*class="[^"]*header[^"]*"[^>]*>(.*?)<\/h1>/i,
    /<title>(.*?)<\/title>/i
  ];
  for (const rx of tries) {
    const m = html.match(rx);
    if (m) {
      const name = m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (name) return name;
    }
  }
  return listUrl;
}

function parseTconsts(html) {
  const seen = new Set(); const out = [];
  let m;
  const re1 = /data-tconst="(tt\d{7,})"/gi;
  while ((m = re1.exec(html))) { const tt = m[1]; if (!seen.has(tt)) { seen.add(tt); out.push(tt); } }
  const re2 = /\/title\/(tt\d{7,})/gi;
  while ((m = re2.exec(html))) { const tt = m[1]; if (!seen.has(tt)) { seen.add(tt); out.push(tt); } }
  return out;
}
function findNextPage(html) {
  let m = html.match(/<a[^>]+rel="next"[^>]+href="([^"]+)"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*lister-page-next[^"]*"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*data-testid="pagination-next-page-button"[^>]*>/i);
  if (!m) return null;
  try { return new URL(m[1], "https://www.imdb.com").toString(); } catch { return null; }
}
async function fetchListItemsAllPages(listUrl, maxPages = 60) {
  const modes = ["detail", "grid", "compact"];
  const seen = new Set(); const ids = [];
  for (const mode of modes) {
    let pageUrl = withParam(listUrl, "mode", mode);
    let pages = 0;
    while (pageUrl && pages < maxPages) {
      let html;
      try { html = await fetchText(withParam(pageUrl, "_", Date.now()), "text/html"); }
      catch { break; }
      const found = parseTconsts(html);
      let added = 0;
      for (const tt of found) if (!seen.has(tt)) { seen.add(tt); ids.push(tt); added++; }
      pages++;
      const next = findNextPage(html);
      if (!next || added === 0) break;
      pageUrl = next;
    }
    if (ids.length) break;
  }
  return ids;
}

// ---------- METADATA ----------
async function fetchCinemeta(kind, imdbId) {
  try {
    const j = await fetchJson(`${CINEMETA}/meta/${kind}/${imdbId}.json`);
    return j && j.meta ? j.meta : null;
  } catch { return null; }
}
async function imdbTitleJsonLd(imdbId) {
  try {
    const html = await fetchText(`https://www.imdb.com/title/${imdbId}/`, "text/html");
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (m) {
      try { return JSON.parse(m[1]); } catch {}
    }
    const t = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    const p = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    return { name: t ? t[1] : undefined, image: p ? p[1] : undefined };
  } catch { return null; }
}
async function resolveEpisodeToSeries(imdbId) {
  if (EP2SER.has(imdbId)) return EP2SER.get(imdbId);
  const ld = await imdbTitleJsonLd(imdbId);
  let seriesId = null;
  try {
    const node = Array.isArray(ld && ld["@graph"]) ? ld["@graph"].find(x => x["@type"] === "TVEpisode") : ld;
    const part = node && (node.partOfSeries || node.partOfTVSeries || (node.partOfSeason && node.partOfSeason.partOfSeries));
    if (part) {
      const url = typeof part === "string" ? part : (part.url || part.sameAs || part["@id"]);
      if (url) {
        const m = String(url).match(/tt\d{7,}/i);
        if (m) seriesId = m[0];
      }
    }
  } catch {}
  if (seriesId) EP2SER.set(imdbId, seriesId);
  return seriesId;
}

async function getBestMeta(imdbId) {
  if (BEST.has(imdbId)) return BEST.get(imdbId);

  // Cinemeta: try movie then series
  let meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind: "movie", meta }; BEST.set(imdbId, rec); return rec; }
  meta = await fetchCinemeta("series", imdbId);
  if (meta) { const rec = { kind: "series", meta }; BEST.set(imdbId, rec); return rec; }

  // IMDb JSON-LD / OG fallback (minimal)
  const ld = await imdbTitleJsonLd(imdbId);
  let kind = "movie", name, poster, released, year, type;
  try {
    const node = Array.isArray(ld && ld["@graph"]) ? ld["@graph"].find(x => x["@id"]?.includes(`/title/${imdbId}`)) || ld["@graph"][0] : ld;
    name = node?.name || node?.headline || ld?.name;
    poster = (typeof node?.image === "string" ? node.image : node?.image?.url) || ld?.image;
    released = node?.datePublished || node?.startDate || node?.releaseDate;
    year = released ? Number(String(released).slice(0,4)) : undefined;
    const t = (Array.isArray(node?.["@type"]) ? node["@type"][0] : node?.["@type"]) || "";
    if (/Series/i.test(t)) type = "series";
    else if (/TVEpisode/i.test(t)) type = "episode";
    else type = "movie";
    kind = type === "series" ? "series" : "movie";
  } catch {}
  const rec = { kind, meta: name ? { name, poster, released, year } : null };
  BEST.set(imdbId, rec);
  if (name || poster) FALLBK.set(imdbId, { name, poster, releaseDate: released, year, type: kind });
  return rec;
}

function toTs(dateStr, year) {
  if (dateStr) { const t = Date.parse(dateStr); if (!Number.isNaN(t)) return t; }
  if (year)    { const t = Date.parse(`${year}-01-01`); if (!Number.isNaN(t)) return t; }
  return null;
}
function buildCard(imdbId) {
  const rec = BEST.get(imdbId) || { kind: null, meta: null };
  const meta = rec.meta || {};
  const fb   = FALLBK.get(imdbId) || {};
  return {
    id: imdbId,
    type: rec.kind || fb.type || "movie",
    name: meta.name || fb.name || imdbId,
    poster: meta.poster || fb.poster || undefined,
    imdbRating: meta.imdbRating ?? undefined,
    runtime: meta.runtime ?? undefined,
    year: meta.year ?? fb.year ?? undefined,
    releaseDate: meta.released ?? meta.releaseInfo ?? fb.releaseDate ?? undefined,
    description: meta.description || undefined
  };
}

// ---------- SYNC ----------
async function fullSync({ rediscover = true } = {}) {
  if (syncInProgress) return;
  syncInProgress = true;
  try {
    let discovered = [];
    if (IMDB_USER_URL && rediscover) {
      try { discovered = await discoverListsFromUser(IMDB_USER_URL); }
      catch(e){ console.warn("IMDb discovery failed:", e.message); }
    }

    // Merge with existing (handle temporary IMDb hiccups)
    const next = Object.create(null);
    const toFetch = [];

    const knownIds = new Set(Object.keys(LISTS));
    for (const D of discovered) {
      next[D.id] = { id: D.id, name: D.name || D.id, url: D.url, ids: [] };
      toFetch.push(D.id);
      knownIds.delete(D.id);
    }
    for (const leftover of knownIds) {
      next[leftover] = LISTS[leftover];
      if (next[leftover] && (!next[leftover].ids || !next[leftover].ids.length)) toFetch.push(leftover);
    }

    // fetch items per list
    const unique = new Set();
    for (const id of Object.keys(next)) {
      const url = next[id].url || `https://www.imdb.com/list/${id}/`;
      let ids = [];
      try { ids = await fetchListItemsAllPages(url); } catch {}
      next[id].ids = ids;
      for (const tt of ids) unique.add(tt);
    }

    // upgrade episodes → series if enabled
    const maybe = Array.from(unique);
    const finalSet = new Set();
    for (const tt of maybe) {
      let final = tt;
      if (PREFS.upgradeEpisodes) {
        const fb = FALLBK.get(tt);
        if (fb && fb.type === "episode") {
          const ser = await resolveEpisodeToSeries(tt);
          if (ser && isImdb(ser)) final = ser;
        }
      }
      finalSet.add(final);
    }

    // preload meta & build cards
    for (const tt of finalSet) { await getBestMeta(tt); }
    CARD.clear();
    for (const tt of finalSet) { CARD.set(tt, buildCard(tt)); }

    // remap list ids if upgraded
    if (PREFS.upgradeEpisodes) {
      for (const id of Object.keys(next)) {
        const remapped = [];
        const seen = new Set();
        for (const tt of next[id].ids) {
          let f = tt;
          const fb = FALLBK.get(tt);
          if (fb && fb.type === "episode") {
            const ser = await resolveEpisodeToSeries(tt);
            if (ser) f = ser;
          }
          if (!seen.has(f)) { seen.add(f); remapped.push(f); }
        }
        next[id].ids = remapped;
      }
    }

    LISTS = next;
    LAST_SYNC_AT = Date.now();

    console.log(`[SYNC] ok – ${finalSet.size} ids across ${Object.keys(LISTS).length} lists in 0 min`);

    if (GH_ENABLED) {
      try {
        await ghWriteSnapshot({
          lastSyncAt: LAST_SYNC_AT,
          lists: LISTS,
          prefs: PREFS,
          fallback: Object.fromEntries(FALLBK),
          cards: Object.fromEntries(CARD),
          ep2ser: Object.fromEntries(EP2SER)
        });
      } catch (e) { console.warn("[SYNC] snapshot save failed:", e.message); }
    }

  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    syncInProgress = false;
  }
}
function scheduleNextSync() {
  if (syncTimer) clearTimeout(syncTimer);
  if (IMDB_SYNC_MINUTES <= 0) return;
  syncTimer = setTimeout(async () => {
    await fullSync({ rediscover: true });
    scheduleNextSync();
  }, minToMs(IMDB_SYNC_MINUTES));
}
async function bootFromSnapshot() {
  if (!GH_ENABLED) return false;
  const snap = await ghReadSnapshot();
  if (!snap) return false;
  try {
    LISTS = snap.lists || LISTS;
    PREFS = { ...PREFS, ...(snap.prefs || {}) };
    FALLBK.clear(); if (snap.fallback) for (const [k,v] of Object.entries(snap.fallback)) FALLBK.set(k, v);
    CARD.clear();   if (snap.cards)    for (const [k,v] of Object.entries(snap.cards))    CARD.set(k, v);
    EP2SER.clear(); if (snap.ep2ser)   for (const [k,v] of Object.entries(snap.ep2ser))   EP2SER.set(k, v);
    LAST_SYNC_AT = snap.lastSyncAt || 0;
    console.log("[BOOT] snapshot loaded from GitHub");
    return true;
  } catch(e){ console.warn("[BOOT] invalid snapshot:", e.message); return false; }
}

// ---------- SERVER ----------
const app = express();
app.use((_, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });
app.use(express.json());

function addonAllowed(req) {
  if (!SHARED_SECRET) return true;
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return u.searchParams.get("key") === SHARED_SECRET;
}
function adminAllowed(req) {
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return (u.searchParams.get("admin") || req.headers["x-admin-key"]) === ADMIN_PASSWORD;
}
function absoluteBase(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

app.get("/health", (_, res) => res.status(200).send("ok"));

// ------- Manifest (strict semver 10.0.0) -------
const baseManifest = {
  id: "org.mylists.stable",
  version: "10.0.0",
  name: "My Lists",
  description: "Your IMDb lists as fast Stremio catalogs.",
  resources: ["catalog", "meta"],
  types: ["my lists", "movie", "series"],
  idPrefixes: ["tt"]
};
function effectiveEnabledListIds() {
  const discovered = Object.keys(LISTS);
  if (!PREFS.enabled || !PREFS.enabled.length) return discovered;
  const set = new Set(discovered);
  return PREFS.enabled.filter(id => set.has(id));
}
function catalogs() {
  const enabled = effectiveEnabledListIds();
  const ordering = new Map(enabled.map((id, i) => [id, i + 1000]));
  (PREFS.order || []).forEach((id, idx) => { if (ordering.has(id)) ordering.set(id, idx); });
  const sorted = enabled.slice().sort((a,b) => {
    const ia = ordering.get(a) ?? 9999, ib = ordering.get(b) ?? 9999;
    if (ia !== ib) return ia - ib;
    const na = LISTS[a]?.name || a, nb = LISTS[b]?.name || b;
    return na.localeCompare(nb);
  });
  return sorted.map(lsid => ({
    type: "My lists",
    id: `list:${lsid}`,
    name: `🗂 ${LISTS[lsid]?.name || lsid}`,
    extraSupported: ["search","skip","limit","sort"],
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
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...baseManifest, catalogs: catalogs() });
  } catch (e) {
    console.error("Manifest error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ------- Helpers -------
function parseExtra(extraStr, queryObj) {
  const params = new URLSearchParams(extraStr || "");
  const fromPath = Object.fromEntries(params.entries());
  return { ...fromPath, ...(queryObj || {}) };
}
function sortMetas(metas, key) {
  const s = String(key || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const field = s.split("_")[0];
  const cmpNullBottom = (a,b) => {
    const na = a == null, nb = b == null;
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  return metas
    .map((m,i)=>({m,i}))
    .sort((A,B)=>{
      const a=A.m,b=B.m; let c=0;
      if (field==="date") c = cmpNullBottom(toTs(a.releaseDate, a.year), toTs(b.releaseDate, b.year));
      else if (field==="rating") c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
      else if (field==="runtime") c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
      else c = (a.name||"").localeCompare(b.name||"");
      if (c===0){ c=(a.name||"").localeCompare(b.name||""); if (c===0) c=(a.id||"").localeCompare(b.id||""); if (c===0) c=A.i-B.i; }
      return c*dir;
    })
    .map(x=>x.m);
}
const toTs = (d,y) => toTs2(d,y);
function toTs2(dateStr, year) {
  if (dateStr) { const t = Date.parse(dateStr); if (!Number.isNaN(t)) return t; }
  if (year)    { const t = Date.parse(`${year}-01-01`); if (!Number.isNaN(t)) return t; }
  return null;
}

// ------- Catalog -------
app.get("/catalog/:type/:id/:extra?.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    res.setHeader("Cache-Control", "no-store");

    const { id } = req.params;
    if (!id || !id.startsWith("list:")) return res.json({ metas: [] });

    const lsid = id.slice(5);
    const list = LISTS[lsid];
    if (!list) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q     = String(extra.search || "").toLowerCase().trim();
    const sort  = (extra.sort || PREFS.perListSort?.[lsid] || "name_asc").toLowerCase();
    const skip  = Math.max(0, Number(extra.skip  || 0));
    const limit = Math.min(Number(extra.limit || 100), 200);

    let metas = (list.ids || []).map(tt => CARD.get(tt) || buildCard(tt));
    if (q) {
      metas = metas.filter(m =>
        (m.name || "").toLowerCase().includes(q) ||
        (m.id || "").toLowerCase().includes(q) ||
        (m.description || "").toLowerCase().includes(q)
      );
    }
    metas = sortMetas(metas, sort);
    res.json({ metas: metas.slice(skip, skip + limit) });
  } catch (e) {
    console.error("Catalog error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ------- Meta -------
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
      const fb = FALLBK.get(imdbId) || {};
      return res.json({ meta: { id: imdbId, type: rec?.kind || fb.type || "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
    }
    return res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
  } catch (e) {
    console.error("Meta error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ------- Admin -------
app.get("/admin", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  const base = absoluteBase(req);
  const manifestUrl = `${base}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;

  // rediscover (read-only) to show what's seen right now
  let discovered = [];
  try { if (IMDB_USER_URL) discovered = await discoverListsFromUser(IMDB_USER_URL); } catch {}

  const rows = Object.keys(LISTS).map(id => {
    const L = LISTS[id];
    const count = (L.ids || []).length;
    return `<li><b>${L.name || id}</b> <small>(${count} items)</small><br/><small>${L.url}</small></li>`;
  }).join("") || "<li>(none)</li>";

  const disc = discovered.map(d => `<li><b>${d.name || d.id}</b><br/><small>${d.url}</small></li>`).join("") || "<li>(none found or IMDb unreachable right now).</li>";

  res.type("html").send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Admin</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:900px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
button{padding:10px 16px;border:0;border-radius:8px;background:#6c5ce7;color:#fff;cursor:pointer}
.btn2{background:#2d6cdf}
small{color:#666}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}
table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #eee;text-align:left}
input[type="checkbox"]{transform:scale(1.2);margin-right:8px}
</style></head>
<body>
<h1>My Lists – Admin</h1>

<div class="card">
  <h3>Current Snapshot</h3>
  <ul>${rows}</ul>
  <p><small>Last sync: ${LAST_SYNC_AT ? new Date(LAST_SYNC_AT).toLocaleString() + " (" + Math.round((Date.now()-LAST_SYNC_AT)/60000) + " min ago)" : "never"}</small></p>
  <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}">
    <button class="btn2">Sync IMDb Lists Now</button>
  </form>
  <p><small>Auto-sync every ${IMDB_SYNC_MINUTES} min${IMDB_SYNC_MINUTES ? "" : " (disabled)"}.</small></p>
</div>

<div class="card">
  <h3>Customize (enable/disable, order, defaults)</h3>
  <div id="prefs"></div>
  <p id="saveMsg" style="color:#2d6cdf"></p>
</div>

<div class="card">
  <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
  <ul>${disc}</ul>
</div>

<div class="card">
  <h3>Manifest URL</h3>
  <p class="code">${manifestUrl}</p>
</div>

<script>
async function getPrefs(){ const r = await fetch('/api/prefs?admin=${ADMIN_PASSWORD}'); return r.json(); }
async function getLists(){ const r = await fetch('/api/lists?admin=${ADMIN_PASSWORD}'); return r.json(); }

function el(t,a={},k=[]){const e=document.createElement(t);for(const x in a){if(x==="text")e.textContent=a[x];else if(x==="html")e.innerHTML=a[x];else e.setAttribute(x,a[x]);}k.forEach(c=>e.appendChild(c));return e;}

async function render(){
  const prefs = await getPrefs();
  const lists = await getLists();
  const container = document.getElementById('prefs'); container.innerHTML = "";

  const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));
  const order = prefs.order && prefs.order.length ? prefs.order.slice() : Object.keys(lists);

  const tbl = el('table');
  const head = el('thead',{},[el('tr',{},[
    el('th',{text:'Enabled'}), el('th',{text:'List (lsid)'}), el('th',{text:'Items'}),
    el('th',{text:'Order'}), el('th',{text:'Default sort'})
  ])]);
  tbl.appendChild(head);
  const body = el('tbody');

  function row(lsid){
    const L = lists[lsid]; const tr = el('tr');
    const cb = el('input',{type:'checkbox'}); cb.checked = enabledSet.has(lsid);
    cb.addEventListener('change', ()=>{ if(cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); });

    const nameCell = el('td',{}); nameCell.appendChild(el('div',{text:(L.name||lsid)})); nameCell.appendChild(el('small',{text:lsid}));
    const count = el('td',{text:String((L.ids||[]).length)});
    const orderCell = el('td'); const up=el('button',{text:'↑'}); const dn=el('button',{text:'↓'}); up.style.marginRight='6px';
    up.onclick=()=>{ const i=order.indexOf(lsid); if(i>0){const t=order[i-1]; order[i-1]=order[i]; order[i]=t; render();}};
    dn.onclick=()=>{ const i=order.indexOf(lsid); if(i>=0&&i<order.length-1){const t=order[i+1]; order[i+1]=order[i]; order[i]=t; render();}};
    orderCell.appendChild(up); orderCell.appendChild(dn);

    const sortSel = el('select'); const opts=["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"];
    const def=(prefs.perListSort && prefs.perListSort[lsid])||"name_asc";
    opts.forEach(o=> sortSel.appendChild(el('option',{value:o,text:o, ...(o===def?{selected:""}:{})})));
    sortSel.onchange=()=>{ prefs.perListSort = prefs.perListSort || {}; prefs.perListSort[lsid]=sortSel.value; };

    tr.appendChild(el('td',{},[cb]));
    tr.appendChild(nameCell);
    tr.appendChild(count);
    tr.appendChild(orderCell);
    tr.appendChild(el('td',{},[sortSel]));
    return tr;
  }

  order.forEach(lsid => body.appendChild(row(lsid)));
  tbl.appendChild(body);

  container.appendChild(el('div',{html:'<b>Default list:</b> '}));
  const defSel = el('select'); order.forEach(lsid=> defSel.appendChild(el('option',{value:lsid,text:(lists[lsid].name||lsid), ...(lsid===prefs.defaultList?{selected:""}:{})})));
  container.appendChild(defSel);

  container.appendChild(el('div',{style:'margin-top:8px'}));
  const epCb = el('input',{type:'checkbox'}); epCb.checked = !!prefs.upgradeEpisodes;
  container.appendChild(epCb); container.appendChild(el('span',{text:' Upgrade episodes to parent series'}));

  container.appendChild(el('div',{style:'margin-top:10px'}));
  container.appendChild(tbl);

  const saveMsg = document.getElementById('saveMsg');
  const btn = el('button',{text:'Save'}); btn.onclick = async ()=>{
    const enabled = Array.from(enabledSet);
    const body = { enabled, order, defaultList: defSel.value, perListSort: prefs.perListSort || {}, upgradeEpisodes: epCb.checked };
    saveMsg.textContent = "Saving…";
    const r = await fetch('/api/prefs?admin=${ADMIN_PASSWORD}', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    saveMsg.textContent = await r.text();
    setTimeout(()=> saveMsg.textContent = "", 2500);
  };
  container.appendChild(el('div',{style:'margin-top:10px'},[btn]));
}
render();
</script>
</body></html>`);
});

app.get("/api/lists", (req,res)=>{ if(!adminAllowed(req)) return res.status(403).send("Forbidden"); res.json(LISTS); });
app.get("/api/prefs", (req,res)=>{ if(!adminAllowed(req)) return res.status(403).send("Forbidden"); res.json(PREFS); });
app.post("/api/prefs", async (req,res)=>{
  if(!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const b=req.body||{};
    PREFS.enabled         = Array.isArray(b.enabled)? b.enabled.filter(isListId) : [];
    PREFS.order           = Array.isArray(b.order)  ? b.order.filter(isListId)   : [];
    PREFS.defaultList     = isListId(b.defaultList)? b.defaultList : "";
    PREFS.perListSort     = b.perListSort && typeof b.perListSort==="object" ? b.perListSort : {};
    PREFS.upgradeEpisodes = !!b.upgradeEpisodes;

    if(GH_ENABLED){
      try{
        await ghWriteSnapshot({
          lastSyncAt: LAST_SYNC_AT,
          lists: LISTS, prefs: PREFS,
          fallback: Object.fromEntries(FALLBK),
          cards: Object.fromEntries(CARD),
          ep2ser: Object.fromEntries(EP2SER)
        });
      }catch{}
    }
    res.status(200).send("Saved.");
  }catch(e){ console.error(e); res.status(500).send("Failed to save"); }
});
app.post("/api/sync", async (req,res)=>{
  if(!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{ await fullSync({ rediscover:true }); scheduleNextSync(); res.status(200).send(`Synced at ${nowIso()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`); }
  catch(e){ console.error(e); res.status(500).send(String(e)); }
});

// ---------- BOOT ----------
(async ()=>{
  await bootFromSnapshot();
  fullSync({ rediscover:true }).then(()=> scheduleNextSync());
  app.listen(PORT, HOST, ()=>{
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
  });
})();
