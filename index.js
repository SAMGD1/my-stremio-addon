/* My Lists – IMDb → Stremio (robust + customizable)
 * v10.2
 */
"use strict";
const express = require("express");

// ─── ENV ───────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 7000);
const HOST = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/urXXXXXXX/lists/
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));
const UPGRADE_EPISODES_DEFAULT = String(process.env.UPGRADE_EPISODES || "true").toLowerCase() !== "false";

// Optional fallback: comma-separated ls######## IDs
const IMDB_LIST_IDS = (process.env.IMDB_LIST_IDS || "")
  .split(/[,\s]+/)
  .map(s => s.trim())
  .filter(s => /^ls\d{6,}$/i.test(s));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};
const CINEMETA = "https://v3-cinemeta.strem.io";

// ─── STATE ─────────────────────────────────────────────────────────────────────
/** LISTS = { lsid: { id, name, url, ids:[tt...] } } */
let LISTS = Object.create(null);

const BEST     = new Map(); // Map<tt, {kind:'movie'|'series'|null, meta:object|null}>
const FALLBACK = new Map(); // Map<tt, { name?, poster?, releaseDate?, year?, type? }>
const EP2SER   = new Map(); // Map<episode_tt, series_tt>

let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;

// manifest rev; will produce 10.2.<rev> (strict SemVer)
let MANIFEST_REV = 1;
let LAST_MANIFEST_KEY = "";

// In-memory PREFS (customization)
let PREFS = {
  enabled: [],           // enabled lsid; empty = all
  order: [],             // lsid display order
  defaultList: "",       // lsid opened by default
  perListSort: {},       // { lsid: "date_desc" | "name_asc" | ... }
  upgradeEpisodes: UPGRADE_EPISODES_DEFAULT
};

// ─── helpers ───────────────────────────────────────────────────────────────────
const isImdb   = v => /^tt\d{7,}$/i.test(String(v||""));
const isListId = v => /^ls\d{6,}$/i.test(String(v||""));
const minutes  = ms => Math.round(ms/60000);
const sleep    = ms => new Promise(r => setTimeout(r, ms));

async function fetchText(url) {
  const r = await fetch(url, { headers: REQ_HEADERS, redirect: "follow" });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept":"application/json" }, redirect:"follow" });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}
const withParam = (u,k,v) => { const x = new URL(u); x.searchParams.set(k,v); return x.toString(); };

// ─── discovery ─────────────────────────────────────────────────────────────────
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(withParam(userListsUrl, "_", Date.now()));

  // tolerant: absolute or relative, single or double quotes
  const re = /href=['"](?:https?:\/\/(?:www\.)?imdb\.com)?\/list\/(ls\d{6,})\/['"]/gi;
  const ids = new Set();
  let m;
  while ((m = re.exec(html))) ids.add(m[1]);

  // super-fallback: scan any /list/ls.../ occurence
  if (!ids.size) {
    const re2 = /\/list\/(ls\d{6,})\//gi;
    while ((m = re2.exec(html))) ids.add(m[1]);
  }

  const arr = Array.from(ids).map(id => ({ id, url: `https://www.imdb.com/list/${id}/` }));

  // resolve names quickly
  await Promise.all(arr.map(async L => {
    try { L.name = await fetchListName(L.url); } catch { L.name = L.id; }
  }));
  return arr;
}

async function fetchListName(listUrl) {
  const html = await fetchText(withParam(listUrl, "_", Date.now()));
  const tries = [
    /<h1[^>]+data-testid=["']list-header-title["'][^>]*>(.*?)<\/h1>/i,
    /<h1[^>]*class=["'][^"']*header[^"']*["'][^>]*>(.*?)<\/h1>/i,
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<title>(.*?)<\/title>/i
  ];
  for (const rx of tries) {
    const m = html.match(rx);
    if (m) return m[1].replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
  }
  return listUrl;
}

function tconstsFromHtml(html) {
  const out = []; const seen = new Set(); let m;
  const re1 = /data-tconst=["'](tt\d{7,})["']/gi;
  while ((m = re1.exec(html))) if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  const re2 = /\/title\/(tt\d{7,})\//gi;
  while ((m = re2.exec(html))) if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  return out;
}
function nextPageUrl(html) {
  let m = html.match(/<a[^>]+rel=["']next["'][^>]+href=["']([^"']+)["']/i);
  if (!m) m = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*lister-page-next[^"']*["']/i);
  if (!m) m = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*data-testid=["']pagination-next-page-button["'][^>]*>/i);
  if (!m) return null;
  try { return new URL(m[1], "https://www.imdb.com").toString(); } catch { return null; }
}

async function fetchImdbListIdsAllPages(listUrl, maxPages = 80) {
  const modes = ["detail", "grid", "compact"];
  const seen = new Set(); const ids = [];
  for (const mode of modes) {
    let url = withParam(listUrl, "mode", mode);
    let pages = 0;
    while (url && pages < maxPages) {
      let html; try { html = await fetchText(withParam(url, "_", Date.now())); } catch { break; }
      const found = tconstsFromHtml(html);
      let added = 0;
      for (const tt of found) if (!seen.has(tt)) { seen.add(tt); ids.push(tt); added++; }
      pages++;
      const next = nextPageUrl(html);
      if (!next || !added) break;
      url = next;
      await sleep(80); // be gentle
    }
    if (ids.length) break;
  }
  return ids;
}

// ─── metadata ─────────────────────────────────────────────────────────────────
async function fetchCinemeta(kind, imdbId) {
  try {
    const j = await fetchJson(`${CINEMETA}/meta/${kind}/${imdbId}.json`);
    return j && j.meta ? j.meta : null;
  } catch { return null; }
}
async function imdbJsonLd(imdbId) {
  try {
    const html = await fetchText(`https://www.imdb.com/title/${imdbId}/`);
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (m) { try { return JSON.parse(m[1]); } catch {} }
    const t = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const p = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    return { name: t ? t[1] : undefined, image: p ? p[1] : undefined };
  } catch { return null; }
}
async function episodeParentSeries(imdbId) {
  if (EP2SER.has(imdbId)) return EP2SER.get(imdbId);
  const ld = await imdbJsonLd(imdbId);
  let seriesId = null;
  try {
    const node = Array.isArray(ld && ld["@graph"]) ? ld["@graph"].find(x => /TVEpisode/i.test(x["@type"])) : ld;
    const part = node && (node.partOfSeries || node.partOfTVSeries || (node.partOfSeason && node.partOfSeason.partOfSeries));
    const url = typeof part === "string" ? part : (part && (part.url || part.sameAs || part["@id"]));
    if (url) { const m = String(url).match(/tt\d{7,}/i); if (m) seriesId = m[0]; }
  } catch {}
  if (seriesId) EP2SER.set(imdbId, seriesId);
  return seriesId;
}
async function getBestMeta(imdbId) {
  if (BEST.has(imdbId)) return BEST.get(imdbId);

  // series first, then movie — reduces mis-typed shows
  let meta = await fetchCinemeta("series", imdbId);
  if (meta) { const rec = { kind: "series", meta }; BEST.set(imdbId, rec); return rec; }
  meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind: "movie", meta }; BEST.set(imdbId, rec); return rec; }

  // fallback: IMDb JSON-LD/OG
  const ld = await imdbJsonLd(imdbId);
  let name, poster, released, year, type = "movie";
  try {
    const node = Array.isArray(ld && ld["@graph"])
      ? ld["@graph"].find(x => x["@id"]?.includes(`/title/${imdbId}`)) || ld["@graph"][0]
      : ld;
    name = node?.name || node?.headline || ld?.name;
    poster = typeof node?.image === "string" ? node.image : (node?.image?.url || ld?.image);
    released = node?.datePublished || node?.startDate || node?.releaseDate || undefined;
    year = released ? Number(String(released).slice(0,4)) : undefined;
    const t = Array.isArray(node?.["@type"]) ? node["@type"].join(",") : (node?.["@type"] || "");
    if (/Series/i.test(t)) type = "series";
    else if (/TVEpisode/i.test(t)) type = "episode";
  } catch {}
  const rec = { kind: type === "series" ? "series" : "movie", meta: name ? { name, poster, released, year } : null };
  BEST.set(imdbId, rec);
  if (name || poster) FALLBACK.set(imdbId, { name, poster, releaseDate: released, year, type: rec.kind });
  return rec;
}
function cardFor(imdbId) {
  const rec = BEST.get(imdbId) || { kind: null, meta: null };
  const m = rec.meta || {};
  const fb = FALLBACK.get(imdbId) || {};
  return {
    id: imdbId,
    type: rec.kind || fb.type || "movie",
    name: m.name || fb.name || imdbId,
    poster: m.poster || fb.poster || undefined,
    imdbRating: m.imdbRating ?? undefined,
    runtime: m.runtime ?? undefined,
    year: m.year ?? fb.year ?? undefined,
    releaseDate: m.released || m.releaseInfo || fb.releaseDate || undefined,
    description: m.description || undefined
  };
}
function toTs(d,y){
  if (d) { const t = Date.parse(d); if (!Number.isNaN(t)) return t; }
  if (y) { const t = Date.parse(`${y}-01-01`); if (!Number.isNaN(t)) return t; }
  return null;
}
function stableSort(items, sort) {
  const s = String(sort || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const key = s.split("_")[0];
  const cmpNullBottom = (a,b) => (a==null && b==null)?0 : (a==null?1 : (b==null?-1 : (a<b?-1:(a>b?1:0))));
  return items.map((m,i)=>({m,i})).sort((A,B)=>{
    const a=A.m,b=B.m; let c=0;
    if (key==="date") c = cmpNullBottom(toTs(a.releaseDate,a.year), toTs(b.releaseDate,b.year));
    else if (key==="rating") c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
    else if (key==="runtime") c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
    else c = (a.name||"").localeCompare(b.name||"");
    if (c===0){ c=(a.name||"").localeCompare(b.name||""); if(c===0) c=(a.id||"").localeCompare(b.id||""); if(c===0) c=A.i-B.i; }
    return c*dir;
  }).map(x=>x.m);
}
async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  const runners = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (i < arr.length) {
      const idx = i++;
      out[idx] = await fn(arr[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

// ─── sync ──────────────────────────────────────────────────────────────────────
function manifestKey() {
  const ids = Object.keys(LISTS).sort().join(",");
  const names = Object.keys(LISTS).map(id => LISTS[id]?.name || id).sort().join("|");
  const prefsSig = JSON.stringify({
    enabled: PREFS.enabled, order: PREFS.order, defaultList: PREFS.defaultList,
    perListSort: PREFS.perListSort, upgradeEpisodes: PREFS.upgradeEpisodes
  });
  return ids + "#" + names + "#" + prefsSig;
}
async function fullSync({ rediscover = true } = {}) {
  if (syncInProgress) return;
  syncInProgress = true;
  const started = Date.now();
  try {
    let discovered = [];
    if (IMDB_USER_URL && rediscover) {
      try { discovered = await discoverListsFromUser(IMDB_USER_URL); }
      catch (e) { console.warn("[DISCOVER] failed:", e.message); }
    }
    if ((!discovered || !discovered.length) && IMDB_LIST_IDS.length) {
      discovered = IMDB_LIST_IDS.map(id => ({ id, name: id, url: `https://www.imdb.com/list/${id}/` }));
      console.log(`[DISCOVER] used IMDB_LIST_IDS fallback (${discovered.length})`);
    }

    const next = Object.create(null);
    const seen = new Set();
    for (const d of discovered) { next[d.id] = { id: d.id, name: d.name || d.id, url: d.url, ids: [] }; seen.add(d.id); }
    for (const id of Object.keys(LISTS)) if (!seen.has(id)) next[id] = LISTS[id];

    const uniques = new Set();
    for (const id of Object.keys(next)) {
      const url = next[id].url || `https://www.imdb.com/list/${id}/`;
      let ids = [];
      try { ids = await fetchImdbListIdsAllPages(url); } catch {}
      next[id].ids = ids;
      ids.forEach(tt => uniques.add(tt));
      await sleep(80);
    }

    let idsToPreload = Array.from(uniques);
    if (PREFS.upgradeEpisodes) {
      const up = new Set();
      for (const tt of idsToPreload) {
        const rec = await getBestMeta(tt);
        if (!rec.meta) {
          const s = await episodeParentSeries(tt);
          up.add(s && isImdb(s) ? s : tt);
        } else up.add(tt);
      }
      idsToPreload = Array.from(up);

      // remap per list
      for (const id of Object.keys(next)) {
        const remapped = []; const s = new Set();
        for (const tt of next[id].ids) {
          let fin = tt;
          const r = BEST.get(tt);
          if (!r || !r.meta) { const z = await episodeParentSeries(tt); if (z) fin = z; }
          if (!s.has(fin)) { s.add(fin); remapped.push(fin); }
        }
        next[id].ids = remapped;
      }
    }

    await mapLimit(idsToPreload, 8, getBestMeta);

    LISTS = next;
    LAST_SYNC_AT = Date.now();

    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) {
      LAST_MANIFEST_KEY = key;
      MANIFEST_REV++;
      console.log("[SYNC] catalogs changed → manifest rev", MANIFEST_REV);
    }

    console.log(`[SYNC] ok – ${idsToPreload.length} ids across ${Object.keys(LISTS).length} lists in ${minutes(Date.now()-started)} min`);
  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    syncInProgress = false;
  }
}
function scheduleNextSync() {
  if (syncTimer) clearTimeout(syncTimer);
  if (IMDB_SYNC_MINUTES <= 0) return;
  syncTimer = setTimeout(() => fullSync({ rediscover:true }).then(scheduleNextSync), IMDB_SYNC_MINUTES*60*1000);
}
function maybeBackgroundSync() {
  if (IMDB_SYNC_MINUTES <= 0) return;
  const stale = Date.now() - LAST_SYNC_AT > IMDB_SYNC_MINUTES*60*1000;
  if (stale && !syncInProgress) fullSync({ rediscover:true }).then(scheduleNextSync);
}

// ─── server ───────────────────────────────────────────────────────────────────
const app = express();
app.use((_, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });
app.use(express.json()); // required for POST /api/prefs

function addonAllowed(req){
  if (!SHARED_SECRET) return true;
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return u.searchParams.get("key") === SHARED_SECRET;
}
function adminAllowed(req){
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return (u.searchParams.get("admin") || req.headers["x-admin-key"]) === ADMIN_PASSWORD;
}
const absoluteBase = req => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
};

app.get("/health", (_,res)=>res.status(200).send("ok"));

// Manifest (strict SemVer: 10.2.<rev>)
const baseManifest = {
  id: "org.mylists.snapshot",
  version: "10.2.0",
  name: "My Lists",
  description: "Your IMDb lists as catalogs (cached).",
  resources: ["catalog","meta"],
  types: ["my lists","movie","series"],
  idPrefixes: ["tt"]
};

function effectiveEnabledListIds() {
  const all = Object.keys(LISTS);
  if (!PREFS.enabled || !PREFS.enabled.length) return all;
  const set = new Set(all);
  return PREFS.enabled.filter(id => set.has(id));
}
function catalogs(){
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
      { name:"search" }, { name:"skip" }, { name:"limit" },
      { name:"sort", options:["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"] }
    ],
    posterShape: "poster"
  }));
}
app.get("/manifest.json", (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    // strict SemVer: "10.2.<rev>"
    const [major, minor] = baseManifest.version.split("."); // "10","2","0" → we only use first two parts
    const version = `${major}.${minor}.${MANIFEST_REV}`;

    res.json({ ...baseManifest, version, catalogs: catalogs() });
  }catch(e){
    console.error("manifest:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Catalog
function parseExtra(extraStr, qObj){
  const p = new URLSearchParams(extraStr||"");
  return { ...Object.fromEntries(p.entries()), ...(qObj||{}) };
}
app.get("/catalog/:type/:id/:extra?.json", (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const { id } = req.params;
    if (!id || !id.startsWith("list:")) return res.json({ metas: [] });
    const lsid = id.slice(5);
    const list = LISTS[lsid];
    if (!list) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q = String(extra.search||"").toLowerCase().trim();
    const sort = String(extra.sort || PREFS.perListSort?.[lsid] || "name_asc").toLowerCase();
    const skip = Math.max(0, Number(extra.skip||0));
    const limit = Math.min(Number(extra.limit||100), 200);

    let metas = (list.ids||[]).map(cardFor);
    if (q) metas = metas.filter(m =>
      (m.name||"").toLowerCase().includes(q) ||
      (m.id||"").toLowerCase().includes(q) ||
      (m.description||"").toLowerCase().includes(q)
    );
    metas = stableSort(metas, sort);
    res.json({ metas: metas.slice(skip, skip+limit) });
  }catch(e){ console.error("catalog:", e); res.status(500).send("Internal Server Error"); }
});

// Meta
app.get("/meta/:type/:id.json", async (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const imdbId = req.params.id;
    if (!isImdb(imdbId)) return res.json({ meta:{ id: imdbId, type:"movie", name:"Unknown item" } });

    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);
    if (!rec || !rec.meta) {
      const fb = FALLBACK.get(imdbId) || {};
      return res.json({ meta: { id: imdbId, type: rec?.kind || fb.type || "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
    }
    res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
  }catch(e){ console.error("meta:", e); res.status(500).send("Internal Server Error"); }
});

// ─── Admin (customize UI) ─────────────────────────────────────────────────────
app.get("/admin", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  const base = absoluteBase(req);
  const manifestUrl = `${base}/manifest.json${SHARED_SECRET?`?key=${SHARED_SECRET}`:""}`;

  let discovered = [];
  try { if (IMDB_USER_URL) discovered = await discoverListsFromUser(IMDB_USER_URL); } catch {}

  const disc = discovered.map(d=>`<li><b>${d.name||d.id}</b><br/><small>${d.url}</small></li>`).join("") || "<li>(none found or IMDb unreachable right now).</li>";

  res.type("html").send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Admin</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:980px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
button{padding:10px 16px;border:0;border-radius:8px;background:#2d6cdf;color:#fff;cursor:pointer}
small{color:#666}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}
.badge{display:inline-block;background:#eee;border-radius:999px;padding:2px 8px;font-size:12px;margin-left:6px}
table{width:100%;border-collapse:collapse}
th,td{padding:8px;border-bottom:1px solid #eee;text-align:left}
tr.dragging{opacity:.6}
</style></head><body>
<h1>My Lists – Admin</h1>

<div class="card" id="snap">
  <h3>Current Snapshot</h3>
  <ul id="snapRows"></ul>
  <p><small id="lastSync">Last sync: never</small></p>
  <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}"><button>Sync IMDb Lists Now</button></form>
  <p class="badge">Auto-sync every ${IMDB_SYNC_MINUTES} min${IMDB_SYNC_MINUTES ? "" : " (disabled)"}.</p>
</div>

<div class="card">
  <h3>Customize (enable/disable, order, defaults)</h3>
  <p>Drag rows to change order. First enabled row opens by default unless you pick one below.</p>
  <div style="margin:6px 0">
    <b>Default list:</b> <select id="defaultList"></select>
    <label style="margin-left:12px">
      <input type="checkbox" id="upgradeEp"> Upgrade episodes to parent series
    </label>
  </div>
  <table id="tbl">
    <thead><tr>
      <th>Enabled</th><th>List (lsid)</th><th>Items</th><th>Default sort</th>
    </tr></thead>
    <tbody id="tbody"></tbody>
  </table>
  <div style="margin-top:10px"><button id="saveBtn">Save</button></div>
  <p id="saveMsg" style="color:#2d6cdf"></p>
</div>

<div class="card">
  <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
  <ul>${disc}</ul>
  <p><small>Debug: <a href="/api/debug-imdb?admin=${ADMIN_PASSWORD}">open</a> (shows the first part of HTML we receive)</small></p>
</div>

<div class="card">
  <h3>Manifest URL</h3>
  <p class="code">${manifestUrl}</p>
  <p><small>Version bumps automatically when catalogs change.</small></p>
</div>

<script>
async function j(url, opt){ const r = await fetch(url, opt); return r.json ? r.json() : r.text(); }
async function load(){
  const lists = await j('/api/lists?admin=${ADMIN_PASSWORD}');
  const prefs = await j('/api/prefs?admin=${ADMIN_PASSWORD}');
  const snapRows = document.getElementById('snapRows');
  snapRows.innerHTML = "";
  Object.keys(lists).forEach(id=>{
    const L = lists[id];
    const li = document.createElement('li');
    li.innerHTML = '<b>'+ (L.name||id) + '</b> <small>('+(L.ids||[]).length+' items)</small><br/><small>'+(L.url||'')+'</small>';
    snapRows.appendChild(li);
  });
  const lastSync = ${LAST_SYNC_AT} ? new Date(${LAST_SYNC_AT}).toLocaleString() + " (" + Math.round((Date.now()-${LAST_SYNC_AT})/60000) + " min ago)" : "never";
  document.getElementById('lastSync').textContent = 'Last sync: ' + lastSync;

  // build table rows (include ALL lists so new ones appear)
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = "";
  const ids = Object.keys(lists).sort((a,b)=> (lists[a].name||a).localeCompare(lists[b].name||b));

  const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : ids);
  const defSel = document.getElementById('defaultList');
  defSel.innerHTML = '<option value=""></option>';
  ids.forEach(lsid => {
    const opt = document.createElement('option');
    opt.value = lsid; opt.textContent = lists[lsid].name || lsid;
    if (prefs.defaultList === lsid) opt.selected = true;
    defSel.appendChild(opt);
  });

  document.getElementById('upgradeEp').checked = !!prefs.upgradeEpisodes;

  const sorts = ["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"];

  ids.forEach(lsid => {
    const L = lists[lsid];
    const tr = document.createElement('tr');
    tr.draggable = true;
    tr.dataset.lsid = lsid;

    const td0 = document.createElement('td');
    const cb = document.createElement('input'); cb.type='checkbox'; cb.checked = enabledSet.has(lsid);
    cb.addEventListener('change', ()=>{ if (cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); });
    td0.appendChild(cb);

    const td1 = document.createElement('td');
    td1.innerHTML = '<div><b>'+ (L.name||lsid) +'</b></div><small>'+lsid+'</small>';

    const td2 = document.createElement('td'); td2.textContent = String((L.ids||[]).length);

    const td3 = document.createElement('td');
    const sel = document.createElement('select');
    sorts.forEach(s => {
      const o=document.createElement('option'); o.value=s; o.textContent=s;
      if ((prefs.perListSort && prefs.perListSort[lsid]) === s) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', ()=>{ prefs.perListSort = prefs.perListSort||{}; prefs.perListSort[lsid]=sel.value; });
    td3.appendChild(sel);

    tr.appendChild(td0); tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
    tbody.appendChild(tr);
  });

  // simple drag sort
  let dragEl=null;
  tbody.addEventListener('dragstart', e=>{ dragEl=e.target.closest('tr'); dragEl.classList.add('dragging'); });
  tbody.addEventListener('dragend', ()=>{ if(dragEl) dragEl.classList.remove('dragging'); dragEl=null; });
  tbody.addEventListener('dragover', e=>{
    e.preventDefault();
    const after = [...tbody.querySelectorAll('tr:not(.dragging)')].find(row => e.clientY <= row.getBoundingClientRect().top + row.offsetHeight/2);
    if (!after) tbody.appendChild(dragEl); else tbody.insertBefore(dragEl, after);
  });

  document.getElementById('saveBtn').onclick = async ()=>{
    const order = [...tbody.querySelectorAll('tr')].map(tr=>tr.dataset.lsid);
    const enabled = order.filter(lsid => {
      const tr = tbody.querySelector('tr[data-lsid="'+lsid+'"]');
      return tr && tr.querySelector('input[type=checkbox]').checked;
    });
    const body = {
      enabled, order,
      defaultList: defSel.value || "",
      perListSort: prefs.perListSort || {},
      upgradeEpisodes: document.getElementById('upgradeEp').checked
    };
    const r = await fetch('/api/prefs?admin=${ADMIN_PASSWORD}', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    const t = await r.text(); document.getElementById('saveMsg').textContent = t || 'Saved.';
    setTimeout(()=>{ document.getElementById('saveMsg').textContent = ''; }, 2500);
  };
}
load();
</script>
</body></html>`);
});

// API for admin JS
app.get("/api/lists", (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  res.json(LISTS);
});
app.get("/api/prefs", (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  res.json(PREFS);
});
app.post("/api/prefs", (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const body = req.body || {};
    PREFS.enabled         = Array.isArray(body.enabled) ? body.enabled.filter(isListId) : [];
    PREFS.order           = Array.isArray(body.order)   ? body.order.filter(isListId)   : [];
    PREFS.defaultList     = isListId(body.defaultList) ? body.defaultList : "";
    PREFS.perListSort     = body.perListSort && typeof body.perListSort === "object" ? body.perListSort : {};
    PREFS.upgradeEpisodes = !!body.upgradeEpisodes;

    // bump manifest so Stremio refreshes catalogs without reinstall
    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) {
      LAST_MANIFEST_KEY = key;
      MANIFEST_REV++;
    }
    res.status(200).send("Saved. Manifest rev " + MANIFEST_REV);
  }catch(e){ console.error("prefs save:", e); res.status(500).send("Failed to save"); }
});

// manual sync
app.post("/api/sync", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send(`Synced at ${new Date().toISOString()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});

// tiny debug helper
app.get("/api/debug-imdb", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const url = IMDB_USER_URL || req.query.u;
    if (!url) return res.type("text").send("IMDB_USER_URL not set.");
    const html = await fetchText(withParam(url,"_","dbg"));
    res.type("text").send(html.slice(0,2000));
  }catch(e){
    res.type("text").status(500).send("Fetch failed: "+e.message);
  }
});

// ─── BOOT ──────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
  // non-blocking initial sync
  fullSync({ rediscover: true }).then(scheduleNextSync).catch(e => {
    console.warn("[BOOT] background sync failed:", e.message);
  });
});
