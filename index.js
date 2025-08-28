/* My Lists – IMDb → Stremio (persisted + customizable)
 * v10.3.0
 */

"use strict";
const express = require("express");

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 7000);
const HOST = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));
const UPGRADE_EPISODES  = String(process.env.UPGRADE_EPISODES || "true").toLowerCase() !== "false";

// optional fallback: comma-separated ls ids
const IMDB_LIST_IDS = (process.env.IMDB_LIST_IDS || "")
  .split(/[,\s]+/)
  .map(s => s.trim())
  .filter(s => /^ls\d{6,}$/i.test(s));

// GitHub persistence (snapshot + prefs)
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || "";
const GITHUB_OWNER  = process.env.GITHUB_OWNER  || "";
const GITHUB_REPO   = process.env.GITHUB_REPO   || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || "data/snapshot.json";

const GH_ENABLED = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/10.3";
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};
const CINEMETA = "https://v3-cinemeta.strem.io";

// ---------- STATE ----------
let LISTS = Object.create(null); // { lsid: { id, name, url, ids:[tt...] } }
let PREFS = {
  enabled: [],        // [] = all
  order: [],          // lsid[]
  defaultList: "",    // lsid or ""
  perListSort: {},    // { lsid: "date_asc" | ... }
  upgradeEpisodes: UPGRADE_EPISODES
};

const BEST = new Map();     // Map<tt, {kind:'movie'|'series'|null, meta:object|null}>
const FALLBACK = new Map(); // Map<tt, { name?, poster?, releaseDate?, year?, type? }>
const EP2SER = new Map();   // Map<episode_tt, series_tt>
const CARD = new Map();     // Map<tt, card>

let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;
let MANIFEST_REV = 1;
let LAST_MANIFEST_KEY = "";

// ---------- helpers ----------
const isImdb = v => /^tt\d{7,}$/i.test(String(v||""));
const isListId = v => /^ls\d{6,}$/i.test(String(v||""));
const minutes = ms => Math.round(ms/60000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withParam = (u,k,v) => { const x = new URL(u); x.searchParams.set(k,v); return x.toString(); };

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

// ---------- GitHub persistence ----------
async function gh(method, path, bodyObj) {
  if (!GH_ENABLED) throw new Error("GitHub not configured");
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
    const t = await r.text().catch(()=> "");
    throw new Error(`GitHub ${method} ${path} -> ${r.status}: ${t}`);
  }
  return r.json();
}
async function ghGetSha(path) {
  try {
    const data = await gh("GET", `/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    return data && data.sha || null;
  } catch { return null; }
}
async function saveSnapshot() {
  if (!GH_ENABLED) return;
  const payload = {
    lastSyncAt: LAST_SYNC_AT,
    manifestRev: MANIFEST_REV,
    lists: LISTS,
    prefs: PREFS,
    fallback: Object.fromEntries(FALLBACK),
    cards: Object.fromEntries(CARD),
    ep2ser: Object.fromEntries(EP2SER)
  };
  const content = Buffer.from(JSON.stringify(payload, null, 2)).toString("base64");
  const sha = await ghGetSha(SNAPSHOT_PATH);
  const body = { message: "Update snapshot.json", content, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  await gh("PUT", `/contents/${encodeURIComponent(SNAPSHOT_PATH)}`, body);
}
async function loadSnapshot() {
  if (!GH_ENABLED) return false;
  try {
    const data = await gh("GET", `/contents/${encodeURIComponent(SNAPSHOT_PATH)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    const json = JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
    LISTS = json.lists || LISTS;
    PREFS = { ...PREFS, ...(json.prefs || {}) };
    FALLBACK.clear(); if (json.fallback) for (const [k,v] of Object.entries(json.fallback)) FALLBACK.set(k, v);
    CARD.clear();     if (json.cards)    for (const [k,v] of Object.entries(json.cards))    CARD.set(k, v);
    EP2SER.clear();   if (json.ep2ser)   for (const [k,v] of Object.entries(json.ep2ser))   EP2SER.set(k, v);
    LAST_SYNC_AT = json.lastSyncAt || 0;
    MANIFEST_REV = json.manifestRev || MANIFEST_REV;
    LAST_MANIFEST_KEY = manifestKey();
    console.log("[BOOT] snapshot loaded from GitHub");
    return true;
  } catch (e) {
    console.warn("[BOOT] no snapshot:", e.message);
    return false;
  }
}

// ---------- discovery ----------
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(withParam(userListsUrl, "_", Date.now()));
  const re = /href=['"](?:https?:\/\/(?:www\.)?imdb\.com)?\/list\/(ls\d{6,})\/['"]/gi;
  const ids = new Set(); let m;
  while ((m = re.exec(html))) ids.add(m[1]);
  if (!ids.size) {
    const re2 = /\/list\/(ls\d{6,})\//gi;
    while ((m = re2.exec(html))) ids.add(m[1]);
  }
  const arr = Array.from(ids).map(id => ({ id, url: `https://www.imdb.com/list/${id}/` }));
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
  let m = html.match(/<a[^>]+rel=["']next["'][^>]+href=["']([^"']+)"/i);
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
      await sleep(80);
    }
    if (ids.length) break;
  }
  return ids;
}

// ---------- metadata ----------
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
  let meta = await fetchCinemeta("series", imdbId);
  if (meta) { const rec = { kind: "series", meta }; BEST.set(imdbId, rec); CARD.set(imdbId, cardFor(imdbId)); return rec; }
  meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind: "movie", meta }; BEST.set(imdbId, rec); CARD.set(imdbId, cardFor(imdbId)); return rec; }

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
  CARD.set(imdbId, cardFor(imdbId));
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
function toTs(d,y){ if(d){const t=Date.parse(d); if(!Number.isNaN(t)) return t;} if(y){const t=Date.parse(`${y}-01-01`); if(!Number.isNaN(t)) return t;} return null; }
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

// ---------- sync ----------
function effectiveEnabled() {
  const ids = Object.keys(LISTS);
  if (!PREFS.enabled || !PREFS.enabled.length) return ids;
  const set = new Set(ids);
  return PREFS.enabled.filter(x => set.has(x));
}
function manifestKey() {
  const enabled = effectiveEnabled();
  const names = enabled.map(id => LISTS[id]?.name || id).sort().join("|");
  return `${enabled.join(",")}#${(PREFS.order||[]).join(",")}#${PREFS.defaultList}#${names}`;
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
    CARD.clear();
    for (const tt of idsToPreload) CARD.set(tt, cardFor(tt));
    LAST_SYNC_AT = Date.now();

    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) {
      LAST_MANIFEST_KEY = key;
      MANIFEST_REV++;
      console.log("[SYNC] catalogs changed → manifest rev", MANIFEST_REV);
    }

    await saveSnapshot().catch(e=>console.warn("[SYNC] snapshot save failed:", e.message));

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

// ---------- server ----------
const app = express();
app.use(express.json());
app.use((_, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });

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

// Manifest (semver with dots)
const baseManifest = {
  id: "org.mylists.snapshot",
  version: "10.3.0",
  name: "My Lists",
  description: "Your IMDb lists as catalogs (cached, persisted).",
  resources: ["catalog","meta"],
  types: ["my lists","movie","series"],
  idPrefixes: ["tt"]
};
function catalogs(){
  const enabled = effectiveEnabled();
  // preferred order (PREFS.order first), then by name
  const orderIdx = new Map(enabled.map((id,i)=>[id, i+1000]));
  (PREFS.order||[]).forEach((id,idx)=>{ if (orderIdx.has(id)) orderIdx.set(id, idx); });
  const sorted = enabled.slice().sort((a,b)=>{
    const ia = orderIdx.get(a) ?? 9999, ib = orderIdx.get(b) ?? 9999;
    if (ia !== ib) return ia - ib;
    const na=LISTS[a]?.name||a, nb=LISTS[b]?.name||b;
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
    const version = `${baseManifest.version}.${MANIFEST_REV}`;
    res.json({ ...baseManifest, version, catalogs: catalogs() });
  }catch(e){ console.error("manifest:", e); res.status(500).send("Internal Server Error");}
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
    const perListDefault = (PREFS.perListSort && PREFS.perListSort[lsid]) || "name_asc";
    const sort = String(extra.sort || perListDefault).toLowerCase();
    const skip = Math.max(0, Number(extra.skip||0));
    const limit = Math.min(Number(extra.limit||100), 200);

    let metas = (list.ids||[]).map(tt => CARD.get(tt) || cardFor(tt));
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

// Admin (customize UI + debug)
app.get("/admin", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  const base = absoluteBase(req);
  const manifestUrl = `${base}/manifest.json${SHARED_SECRET?`?key=${SHARED_SECRET}`:""}`;

  let discovered = [];
  try { if (IMDB_USER_URL) discovered = await discoverListsFromUser(IMDB_USER_URL); } catch {}

  const rows = Object.keys(LISTS).map(id=>{
    const L = LISTS[id]; const count=(L.ids||[]).length;
    return `<li><b>${L.name||id}</b> <small>(${count} items)</small><br/><small>${L.url||""}</small></li>`;
  }).join("") || "<li>(none)</li>";

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
tr.dragging{opacity:.5}
.handle{cursor:grab}
select{padding:6px 8px;border:1px solid #ddd;border-radius:6px}
</style></head><body>
<h1>My Lists – Admin</h1>

<div class="card">
  <h3>Current Snapshot</h3>
  <ul>${rows}</ul>
  <p><small>Last sync: ${
    LAST_SYNC_AT
     ? `${new Date(LAST_SYNC_AT).toLocaleString()} (${minutes(Date.now()-LAST_SYNC_AT)} min ago)`

      : "never"
  }</small></p>
  <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}"><button>Sync IMDb Lists Now</button></form>
  <span class="badge">Auto-sync every ${IMDB_SYNC_MINUTES} min${IMDB_SYNC_MINUTES ? "" : " (disabled)"}</span>
</div>

<div class="card">
  <h3>Customize (enable/disable, order, defaults)</h3>
  <p>Drag rows to change order. First enabled row opens by default unless you pick one below.</p>
  <div id="prefsUI"></div>
  <div style="margin-top:10px"><button id="saveBtn">Save</button> <span id="msg" style="color:#2d6cdf"></span></div>
</div>

<div class="card">
  <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
  <ul>${disc}</ul>
  <p><small>Debug: <a href="/api/debug-imdb?admin=${ADMIN_PASSWORD}">open</a> (first part of the HTML we receive)</small></p>
</div>

<div class="card">
  <h3>Manifest URL</h3>
  <p class="code">${manifestUrl}</p>
  <p><small>Version bumps automatically when catalogs change.</small></p>
</div>

<script>
async function getPrefs(){ const r = await fetch('/api/prefs?admin=${ADMIN_PASSWORD}'); return r.json(); }
async function getLists(){ const r = await fetch('/api/lists?admin=${ADMIN_PASSWORD}'); return r.json(); }

function el(tag, attrs={}, kids=[]) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === "text") e.textContent = attrs[k];
    else if (k === "html") e.innerHTML = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  kids.forEach(ch => e.appendChild(ch));
  return e;
}

function buildTable(lists, prefs){
  const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));
  const order = prefs.order && prefs.order.length ? prefs.order.slice() : Object.keys(lists);
  const perSort = { ...(prefs.perListSort || {}) };

  const table = el('table');
  const thead = el('thead', {}, [el('tr',{},[
    el('th',{text:'⇅'}), el('th',{text:'Enabled'}), el('th',{text:'List (lsid)'}), el('th',{text:'Items'}), el('th',{text:'Default sort'})
  ])]);
  table.appendChild(thead);
  const tbody = el('tbody');

  function rowFor(lsid){
    const L = lists[lsid];
    const tr = el('tr', { draggable: 'true' });
    tr.addEventListener('dragstart', e => { tr.classList.add('dragging'); e.dataTransfer.setData('text/plain', lsid); });
    tr.addEventListener('dragend',   () => tr.classList.remove('dragging'));
    tr.addEventListener('dragover',  e => e.preventDefault());
    tr.addEventListener('drop', e => {
      e.preventDefault();
      const src = e.dataTransfer.getData('text/plain');
      const si = order.indexOf(src), di = order.indexOf(lsid);
      if (si>=0 && di>=0 && si !== di){ order.splice(si,1); order.splice(di,0,src); render(); }
    });

    const handle = el('td', { class:'handle', text:'⇅' });

    const cb = el('input', {type:'checkbox'}); cb.checked = enabledSet.has(lsid);
    cb.addEventListener('change', ()=>{ if (cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); });

    const sortSel = el('select');
    const opts = ["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"];
    const def = perSort[lsid] || "name_asc";
    opts.forEach(o => sortSel.appendChild(el('option',{value:o,text:o, ...(o===def?{selected:""}:{})})));
    sortSel.addEventListener('change', ()=>{ perSort[lsid] = sortSel.value; });

    const nameCell = el('td',{}); nameCell.appendChild(el('div',{text:(L.name||lsid)})); nameCell.appendChild(el('small',{text:lsid}));

    tr.appendChild(handle);
    tr.appendChild(el('td',{},[cb]));
    tr.appendChild(nameCell);
    tr.appendChild(el('td',{text:String((L.ids||[]).length)}));
    tr.appendChild(el('td',{},[sortSel]));
    tr.dataset.lsid = lsid;
    return tr;
  }

  order.forEach(lsid => tbody.appendChild(rowFor(lsid)));
  table.appendChild(tbody);

  const defLabel = el('label',{html:'<b>Default list:</b> '});
  const defSel = el('select');
  order.forEach(lsid => defSel.appendChild(el('option',{value:lsid,text:(lists[lsid].name||lsid), ...(lsid===prefs.defaultList?{selected:""}:{})})));

  const wrap = el('div');
  wrap.appendChild(defLabel); wrap.appendChild(defSel);
  wrap.appendChild(el('div',{style:'margin-top:8px'}));
  const ep = el('input',{type:'checkbox'}); ep.checked = !!prefs.upgradeEpisodes;
  wrap.appendChild(ep); wrap.appendChild(el('span',{text:' Upgrade episodes to parent series'}));
  wrap.appendChild(el('div',{style:'margin-top:10px'}));
  wrap.appendChild(table);

  return { wrap, collect(){
    return {
      enabled: Array.from(enabledSet),
      order: order.slice(),
      defaultList: defSel.value || "",
      perListSort: perSort,
      upgradeEpisodes: ep.checked
    };
  }};
}

async function render(){
  const prefs = await getPrefs();
  const lists = await getLists();
  const ui = document.getElementById('prefsUI'); ui.innerHTML = "";
  const comp = buildTable(lists, prefs);
  ui.appendChild(comp.wrap);
  document.getElementById('saveBtn').onclick = async ()=>{
    const body = comp.collect();
    const msg = document.getElementById('msg');
    msg.textContent = "Saving…";
    const r = await fetch('/api/prefs?admin=${ADMIN_PASSWORD}', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const t = await r.text();
    msg.textContent = t || "Saved.";
    setTimeout(()=> msg.textContent = "", 2000);
  };
}
render();
</script>
</body></html>`);
});

// lists/prefs APIs
app.get("/api/lists", (req,res)=>{ if (!adminAllowed(req)) return res.status(403).send("Forbidden"); res.json(LISTS); });
app.get("/api/prefs", (req,res)=>{ if (!adminAllowed(req)) return res.status(403).send("Forbidden"); res.json(PREFS); });

app.post("/api/prefs", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const body = req.body || {};
    PREFS.enabled         = Array.isArray(body.enabled) ? body.enabled.filter(isListId) : [];
    PREFS.order           = Array.isArray(body.order)   ? body.order.filter(isListId)   : [];
    PREFS.defaultList     = isListId(body.defaultList) ? body.defaultList : "";
    PREFS.perListSort     = body.perListSort && typeof body.perListSort === "object" ? body.perListSort : {};
    PREFS.upgradeEpisodes = !!body.upgradeEpisodes;

    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) {
      LAST_MANIFEST_KEY = key;
      MANIFEST_REV++;
    }
    await saveSnapshot().catch(()=>{});
    res.status(200).send("Saved. Manifest rev " + MANIFEST_REV);
  } catch (e) {
    console.error("prefs save error:", e);
    res.status(500).send("Failed to save");
  }
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

// debug helper: first 2k of IMDb lists page
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

// ---------- BOOT ----------
(async () => {
  await loadSnapshot();                      // show catalogs instantly after cold start
  fullSync({ rediscover: true }).then(scheduleNextSync).catch(e => {
    console.warn("[BOOT] background sync failed:", e.message);
  });
  app.listen(PORT, HOST, () => {
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
  });
})();
