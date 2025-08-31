/*  My Lists – IMDb → Stremio (custom per-list ordering, sources & UI)
 *  v12.0.1
 */
"use strict";
const express = require("express");
const fs = require("fs/promises");

// ----------------- ENV -----------------
const PORT  = Number(process.env.PORT || 7000);
const HOST  = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));
const UPGRADE_EPISODES  = String(process.env.UPGRADE_EPISODES || "true").toLowerCase() !== "false";

// Optional fallback: comma-separated ls ids
const IMDB_LIST_IDS = (process.env.IMDB_LIST_IDS || "")
  .split(/[,\s]+/).map(s => s.trim()).filter(s => /^ls\d{6,}$/i.test(s));

// Optional GitHub snapshot persistence
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || "";
const GITHUB_OWNER  = process.env.GITHUB_OWNER  || "";
const GITHUB_REPO   = process.env.GITHUB_REPO   || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GH_ENABLED    = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);
const SNAP_LOCAL    = "data/snapshot.json";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/12.0";
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};
const CINEMETA = "https://v3-cinemeta.strem.io";

const SORT_OPTIONS = ["custom","date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"];
const VALID_SORT = new Set(SORT_OPTIONS);

// ----------------- STATE -----------------
/** LISTS = { lsid: { id, name, url, ids:[tt...] } } */
let LISTS = Object.create(null);

/** PREFS saved to snapshot */
let PREFS = {
  enabled: [],            // lsids shown in Stremio
  order: [],              // lsids order in manifest
  defaultList: "",
  perListSort: {},        // { lsid: 'date_asc' | ... | 'custom' }
  sortOptions: {},        // { lsid: ['custom', 'date_desc', ...] } -> controls Stremio dropdown
  customOrder: {},        // { lsid: [ 'tt...', 'tt...' ] }
  upgradeEpisodes: UPGRADE_EPISODES,
  sources: {              // extra sources you add in the UI
    users: [],            // array of user /lists URLs
    lists: []             // array of list URLs or lsids
  },
  blocked: []             // lsids you removed/blocked
};

const BEST   = new Map(); // Map<tt, { kind, meta }>
const FALLBK = new Map(); // Map<tt, { name?, poster?, releaseDate?, year?, type? }>
const EP2SER = new Map(); // Map<episode_tt, parent_series_tt>
const CARD   = new Map(); // Map<tt, card>

let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;

let MANIFEST_REV = 1;
let LAST_MANIFEST_KEY = "";

// ----------------- UTILS -----------------
const isImdb = v => /^tt\d{7,}$/i.test(String(v||""));
const isListId = v => /^ls\d{6,}$/i.test(String(v||""));
const minutes = ms => Math.round(ms/60000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clampSortOptions = arr => (Array.isArray(arr) ? arr.filter(x => VALID_SORT.has(x)) : []);

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

// ---- GitHub snapshot (optional) ----
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
async function saveSnapshot(obj) {
  // local (best effort)
  try {
    await fs.mkdir("data", { recursive: true });
    await fs.writeFile(SNAP_LOCAL, JSON.stringify(obj, null, 2), "utf8");
  } catch {/* ignore */}
  // GitHub (if enabled)
  if (!GH_ENABLED) return;
  const content = Buffer.from(JSON.stringify(obj, null, 2)).toString("base64");
  const path = "data/snapshot.json";
  const sha = await ghGetSha(path);
  const body = { message: "Update snapshot.json", content, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  await gh("PUT", `/contents/${encodeURIComponent(path)}`, body);
}
async function loadSnapshot() {
  // try GitHub first
  if (GH_ENABLED) {
    try {
      const data = await gh("GET", `/contents/${encodeURIComponent("data/snapshot.json")}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
      const buf = Buffer.from(data.content, "base64").toString("utf8");
      return JSON.parse(buf);
    } catch {/* ignore */}
  }
  // local
  try {
    const txt = await fs.readFile(SNAP_LOCAL, "utf8");
    return JSON.parse(txt);
  } catch { return null; }
}

// ----------------- IMDb DISCOVERY -----------------
function normalizeListIdOrUrl(s) {
  if (!s) return null;
  s = String(s).trim();
  const m = s.match(/ls\d{6,}/i);
  if (m) return { id: m[0], url: `https://www.imdb.com/list/${m[0]}/` };
  if (/imdb\.com\/list\//i.test(s)) {
    return { id: null, url: s };
  }
  return null;
}
async function discoverFromUserLists(userListsUrl) {
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
  await Promise.all(arr.map(async L => { try { L.name = await fetchListName(L.url); } catch { L.name = L.id; } }));
  return arr;
}
async function fetchListName(listUrl) {
  const html = await fetchText(withParam(listUrl, "_", Date.now()));
  const tries = [
    /<h1[^>]+data-testid=["']list-header-title["'][^>]*>(.*?)<\/h1>/i,
    /<h1[^>]*class=["'][^"']*header[^"']*["'][^>]*>(.*?)<\/h1>/i,
  ];
  for (const rx of tries) { const m = html.match(rx); if (m) return m[1].replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim(); }
  const t = html.match(/<title>(.*?)<\/title>/i);
  return t ? t[1].replace(/\s+\-\s*IMDb.*$/i,"").trim() : listUrl;
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
      await sleep(80);
    }
    if (ids.length) break;
  }
  return ids;
}

// ----------------- METADATA -----------------
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
  if (meta) { const rec = { kind: "series", meta }; BEST.set(imdbId, rec); return rec; }
  meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind: "movie", meta }; BEST.set(imdbId, rec); return rec; }
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
  if (name || poster) FALLBK.set(imdbId, { name, poster, releaseDate: released, year, type: rec.kind });
  return rec;
}
function cardFor(imdbId) {
  const rec = BEST.get(imdbId) || { kind: null, meta: null };
  const m = rec.meta || {}; const fb = FALLBK.get(imdbId) || {};
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
function stableSort(items, sortKey) {
  const s = String(sortKey || "name_asc").toLowerCase();
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
function applyCustomOrder(metas, lsid) {
  const order = (PREFS.customOrder && PREFS.customOrder[lsid]) || [];
  if (!order || !order.length) return metas.slice();
  const pos = new Map(order.map((id, i) => [id, i]));
  return metas.slice().sort((a,b) => {
    const pa = pos.has(a.id) ? pos.get(a.id) : Number.MAX_SAFE_INTEGER;
    const pb = pos.has(b.id) ? pos.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return (a.name||"").localeCompare(b.name||"");
  });
}

// ----------------- SYNC -----------------
function manifestKey() {
  const enabled = (PREFS.enabled && PREFS.enabled.length) ? PREFS.enabled : Object.keys(LISTS);
  const names = enabled.map(id => LISTS[id]?.name || id).sort().join("|");
  const perSort = JSON.stringify(PREFS.perListSort || {});
  const perOpts = JSON.stringify(PREFS.sortOptions || {});
  const custom = Object.keys(PREFS.customOrder || {}).length;
  const order = (PREFS.order || []).join(",");
  return `${enabled.join(",")}#${order}#${PREFS.defaultList}#${names}#${perSort}#${perOpts}#c${custom}`;
}

async function harvestSources() {
  // 1) your primary IMDB_USER_URL
  const discovered = [];
  if (IMDB_USER_URL) {
    try { discovered.push(...await discoverFromUserLists(IMDB_USER_URL)); } catch(e){ console.warn("[DISCOVER] main failed:", e.message); }
  }
  // 2) extra users from PREFS.sources.users
  const users = Array.from(new Set((PREFS.sources?.users || []).map(s => String(s).trim()).filter(Boolean)));
  for (const u of users) {
    try { discovered.push(...await discoverFromUserLists(u)); }
    catch(e){ console.warn("[DISCOVER] user", u, "failed:", e.message); }
    await sleep(80);
  }
  // 3) explicit lists from PREFS.sources.lists + env fallback
  const addlRaw = (PREFS.sources?.lists || []).concat(IMDB_LIST_IDS || []);
  for (const raw of addlRaw) {
    const norm = normalizeListIdOrUrl(raw);
    if (!norm) continue;
    let id = norm.id;
    let url = norm.url;
    if (!id) {
      const m = String(url).match(/ls\d{6,}/i);
      if (m) id = m[0];
    }
    if (!id) continue;
    let name = id;
    try { name = await fetchListName(url); } catch {}
    discovered.push({ id, url, name });
    await sleep(60);
  }
  // dedupe & blocklist
  const blocked = new Set(PREFS.blocked || []);
  const map = new Map();
  for (const d of discovered) if (!blocked.has(d.id)) map.set(d.id, d);
  return Array.from(map.values());
}

async function fullSync({ rediscover = true } = {}) {
  if (syncInProgress) return;
  syncInProgress = true;
  const started = Date.now();
  try {
    let discovered = [];
    if (rediscover) {
      discovered = await harvestSources();
    }

    if ((!discovered || !discovered.length) && IMDB_LIST_IDS.length) {
      discovered = IMDB_LIST_IDS.map(id => ({ id, name: id, url: `https://www.imdb.com/list/${id}/` }));
      console.log(`[DISCOVER] used IMDB_LIST_IDS fallback (${discovered.length})`);
    }

    const next = Object.create(null);
    const seen = new Set();
    for (const d of discovered) { next[d.id] = { id: d.id, name: d.name || d.id, url: d.url, ids: [] }; seen.add(d.id); }
    // keep previous ones that were not rediscovered *and* not blocked
    const blocked = new Set(PREFS.blocked || []);
    for (const id of Object.keys(LISTS)) if (!seen.has(id) && !blocked.has(id)) next[id] = LISTS[id];

    // pull items
    const uniques = new Set();
    for (const id of Object.keys(next)) {
      const url = next[id].url || `https://www.imdb.com/list/${id}/`;
      let ids = [];
      try { ids = await fetchImdbListIdsAllPages(url); } catch {}
      next[id].ids = ids;
      ids.forEach(tt => uniques.add(tt));
      await sleep(60);
    }

    // episode → series (optional)
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

    // preload cards
    for (const tt of idsToPreload) { await getBestMeta(tt); CARD.set(tt, cardFor(tt)); }

    LISTS = next;
    LAST_SYNC_AT = Date.now();

    // ---- Ensure prefs.order includes newly discovered lists; keep existing order ----
    const allIds   = Object.keys(LISTS);
    const keep     = Array.isArray(PREFS.order) ? PREFS.order.filter(id => LISTS[id]) : [];
    const missingO = allIds.filter(id => !keep.includes(id));
    PREFS.order    = keep.concat(missingO);

    // If enabled set exists, prune removed lists (do not auto-enable new ones here)
    if (Array.isArray(PREFS.enabled) && PREFS.enabled.length) {
      PREFS.enabled = PREFS.enabled.filter(id => LISTS[id]);
    }

    // drop customOrder entries for deleted lists
    const valid = new Set(Object.keys(LISTS));
    if (PREFS.customOrder) {
      for (const k of Object.keys(PREFS.customOrder)) if (!valid.has(k)) delete PREFS.customOrder[k];
    }

    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) {
      LAST_MANIFEST_KEY = key;
      MANIFEST_REV++;
      console.log("[SYNC] catalogs changed → manifest rev", MANIFEST_REV);
    }

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER)
    });

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

// ----------------- SERVER -----------------
const app = express();
app.use((_, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });
app.use(express.json({ limit: "1mb" }));

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

// ------- Manifest -------
const baseManifest = {
  id: "org.mylists.snapshot",
  version: "12.0.1",
  name: "My Lists",
  description: "Your IMDb lists as catalogs (cached).",
  resources: ["catalog","meta"],
  types: ["my lists","movie","series"],
  idPrefixes: ["tt"]
};
function getEnabledOrderedIds() {
  const allIds  = Object.keys(LISTS);
  const enabled = new Set(PREFS.enabled && PREFS.enabled.length ? PREFS.enabled : allIds);
  const base    = (PREFS.order && PREFS.order.length ? PREFS.order.filter(id => LISTS[id]) : []);
  const missing = allIds.filter(id => !base.includes(id))
    .sort((a,b)=>( (LISTS[a]?.name||a).localeCompare(LISTS[b]?.name||b) ));
  const ordered = base.concat(missing);
  return ordered.filter(id => enabled.has(id));
}
function catalogs(){
  const ids = getEnabledOrderedIds();
  return ids.map(lsid => ({
    type: "My lists",
    id: `list:${lsid}`,
    name: `🗂 ${LISTS[lsid]?.name || lsid}`,
    extraSupported: ["search","skip","limit","sort"],
    extra: [
      { name:"search" }, { name:"skip" }, { name:"limit" },
      { name:"sort", options: (PREFS.sortOptions && PREFS.sortOptions[lsid] && PREFS.sortOptions[lsid].length) ? PREFS.sortOptions[lsid] : SORT_OPTIONS }
    ],
    posterShape: "poster"
  }));
}
app.get("/manifest.json", (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();
    const version = `${baseManifest.version}-${MANIFEST_REV}`;
    res.json({ ...baseManifest, version, catalogs: catalogs() });
  }catch(e){ console.error("manifest:", e); res.status(500).send("Internal Server Error");}
});

// ------- Catalog -------
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
    const sortReq = String(extra.sort||"").toLowerCase();
    const defaultSort = (PREFS.perListSort && PREFS.perListSort[lsid]) || "name_asc";
    const sort = sortReq || defaultSort;
    const skip = Math.max(0, Number(extra.skip||0));
    const limit = Math.min(Number(extra.limit||100), 200);

    let metas = (list.ids||[]).map(tt => CARD.get(tt) || cardFor(tt));

    if (q) {
      metas = metas.filter(m =>
        (m.name||"").toLowerCase().includes(q) ||
        (m.id||"").toLowerCase().includes(q) ||
        (m.description||"").toLowerCase().includes(q)
      );
    }

    if (sort === "custom") metas = applyCustomOrder(metas, lsid);
    else metas = stableSort(metas, sort);

    res.json({ metas: metas.slice(skip, skip+limit) });
  }catch(e){ console.error("catalog:", e); res.status(500).send("Internal Server Error"); }
});

// ------- Meta -------
app.get("/meta/:type/:id.json", async (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const imdbId = req.params.id;
    if (!isImdb(imdbId)) return res.json({ meta:{ id: imdbId, type:"movie", name:"Unknown item" } });

    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);
    if (!rec || !rec.meta) {
      const fb = FALLBK.get(imdbId) || {};
      return res.json({ meta: { id: imdbId, type: rec?.kind || fb.type || "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
    }
    res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
  }catch(e){ console.error("meta:", e); res.status(500).send("Internal Server Error"); }
});

// ------- Admin + debug & new endpoints -------
app.get("/api/lists", (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  res.json(LISTS);
});
app.get("/api/prefs", (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  res.json(PREFS);
});
app.post("/api/prefs", async (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const body = req.body || {};
    PREFS.enabled         = Array.isArray(body.enabled) ? body.enabled.filter(isListId) : [];
    PREFS.order           = Array.isArray(body.order)   ? body.order.filter(isListId)   : [];
    PREFS.defaultList     = isListId(body.defaultList) ? body.defaultList : "";
    PREFS.perListSort     = body.perListSort && typeof body.perListSort === "object" ? body.perListSort : (PREFS.perListSort || {});
    PREFS.sortOptions     = body.sortOptions && typeof body.sortOptions === "object" ? Object.fromEntries(Object.entries(body.sortOptions).map(([k,v])=>[k,clampSortOptions(v)])) : (PREFS.sortOptions || {});
    PREFS.upgradeEpisodes = !!body.upgradeEpisodes;

    if (body.customOrder && typeof body.customOrder === "object") {
      PREFS.customOrder = body.customOrder;
    }

    // sources
    const src = body.sources || {};
    PREFS.sources = {
      users: Array.isArray(src.users) ? src.users.map(s=>String(s).trim()).filter(Boolean) : (PREFS.sources.users || []),
      lists: Array.isArray(src.lists) ? src.lists.map(s=>String(s).trim()).filter(Boolean) : (PREFS.sources.lists || [])
    };

    // blocked
    PREFS.blocked = Array.isArray(body.blocked) ? body.blocked.filter(isListId) : (PREFS.blocked || []);

    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) { LAST_MANIFEST_KEY = key; MANIFEST_REV++; }

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER)
    });

    res.status(200).send("Saved. Manifest rev " + MANIFEST_REV);
  }catch(e){ console.error("prefs save error:", e); res.status(500).send("Failed to save"); }
});

// unblock a previously removed list
app.post("/api/unblock-list", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid||"");
    if (!/^ls\d{6,}$/i.test(lsid)) return res.status(400).send("Invalid lsid");
    PREFS.blocked = (PREFS.blocked || []).filter(id => id !== lsid);
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send("Unblocked & synced");
  }catch(e){ console.error(e); res.status(500).send("Failed"); }
});


// return cards for one list (for the drawer)
app.get("/api/list-items", (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  const lsid = String(req.query.lsid || "");
  const list = LISTS[lsid];
  if (!list) return res.json({ items: [] });
  const items = (list.ids||[]).map(tt => CARD.get(tt) || cardFor(tt));
  res.json({ items });
});

// save a per-list custom order and set default sort=custom
app.post("/api/custom-order", async (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid || "");
    const order = Array.isArray(req.body.order) ? req.body.order.filter(isImdb) : [];
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    const list = LISTS[lsid];
    if (!list) return res.status(404).send("List not found");

    const set = new Set(list.ids);
    const clean = order.filter(id => set.has(id)); // keep only items that exist in list

    PREFS.customOrder = PREFS.customOrder || {};
    PREFS.customOrder[lsid] = clean;
    PREFS.perListSort = PREFS.perListSort || {};
    PREFS.perListSort[lsid] = "custom";

    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) { LAST_MANIFEST_KEY = key; MANIFEST_REV++; }

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER)
    });

    res.status(200).json({ ok:true, manifestRev: MANIFEST_REV });
  }catch(e){ console.error("custom-order:", e); res.status(500).send("Failed"); }
});

// add sources quickly then sync
app.post("/api/add-sources", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const users = Array.isArray(req.body.users) ? req.body.users.map(s=>String(s).trim()).filter(Boolean) : [];
    const lists = Array.isArray(req.body.lists) ? req.body.lists.map(s=>String(s).trim()).filter(Boolean) : [];
    PREFS.sources = PREFS.sources || { users:[], lists:[] };
    PREFS.sources.users = Array.from(new Set([ ...(PREFS.sources.users||[]), ...users ]));
    PREFS.sources.lists = Array.from(new Set([ ...(PREFS.sources.lists||[]), ...lists ]));
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send("Sources added & synced");
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});

// remove/block a list
app.post("/api/remove-list", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid||"");
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    delete LISTS[lsid];
    PREFS.enabled = (PREFS.enabled||[]).filter(id => id!==lsid);
    PREFS.order   = (PREFS.order||[]).filter(id => id!==lsid);
    PREFS.blocked = Array.from(new Set([ ...(PREFS.blocked||[]), lsid ]));

    LAST_MANIFEST_KEY = ""; MANIFEST_REV++; // force bump
    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER)
    });
    res.status(200).send("Removed & blocked");
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});

app.post("/api/sync", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send(`Synced at ${new Date().toISOString()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});
app.post("/api/purge-sync", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    LISTS = Object.create(null);
    BEST.clear(); FALLBK.clear(); EP2SER.clear(); CARD.clear();
    PREFS.customOrder = PREFS.customOrder || {};
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send(`Purged & synced at ${new Date().toISOString()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});

app.get("/api/debug-imdb", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const url = IMDB_USER_URL || req.query.u;
    if (!url) return res.type("text").send("IMDB_USER_URL not set.");
    const html = await fetchText(withParam(url,"_","dbg"));
    res.type("text").send(html.slice(0,2000));
  }catch(e){ res.type("text").status(500).send("Fetch failed: "+e.message); }
});

// ------- Admin page (UI refresh + sources & sort-options) -------
app.get("/admin", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  const base = absoluteBase(req);
  const manifestUrl = `${base}/manifest.json${SHARED_SECRET?`?key=${SHARED_SECRET}`:""}`;
  let discovered = [];
  try { discovered = await harvestSources(); } catch {}

  const rows = Object.keys(LISTS).map(id => {
    const L = LISTS[id]; const count=(L.ids||[]).length;
    return `<li><b>${L.name||id}</b> <small>(${count} items)</small><br/><small>${L.url||""}</small></li>`;
  }).join("") || "<li>(none)</li>";

  const disc = discovered.map(d=>`<li><b>${d.name||d.id}</b><br/><small>${d.url}</small></li>`).join("") || "<li>(none)</li>";

  const lastSyncText = LAST_SYNC_AT
    ? (new Date(LAST_SYNC_AT).toLocaleString() + " (" + Math.round((Date.now()-LAST_SYNC_AT)/60000) + " min ago)")
    : "never";

  res.type("html").send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Admin</title>
<style>
  :root{color-scheme:light; --bg:#0f0d1a; --card:#15122b; --muted:#9aa0b4; --text:#f7f7fb; --accent:#6c5ce7; --accent2:#8b7cf7; --border:#2a2650}
  body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:0;background:linear-gradient(180deg,#141126 0%,#0f0d1a 100%);color:var(--text)}
  .wrap{max-width:1100px;margin:24px auto;padding:0 16px}
  .hero{padding:20px 0 8px}
  h1{margin:0 0 4px;font-weight:700}
  .subtitle{color:var(--muted)}
  .grid{display:grid;gap:16px;grid-template-columns:1fr}
  @media(min-width:980px){ .grid{grid-template-columns:1fr 1fr} }
  .card{border:1px solid var(--border);border-radius:14px;padding:16px;background:var(--card);box-shadow:0 8px 24px rgba(0,0,0,.28)}
  button{padding:10px 16px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
  .btn2{background:var(--accent2)}
  small{color:var(--muted)}
  .code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#1c1837;color:#d6d3ff;padding:4px 6px;border-radius:6px}
  table{width:100%;border-collapse:collapse}
  th,td{padding:10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
  .muted{color:var(--muted)}
  .chev{cursor:pointer;font-size:18px;line-height:1;user-select:none}
  .drawer{background:#120f25}
  .thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin:12px 0;padding:0;list-style:none}
  .thumb{display:flex;gap:10px;align-items:center;border:1px solid var(--border);background:#1a1636;border-radius:12px;padding:6px 8px}
  .thumb img{width:52px;height:78px;object-fit:cover;border-radius:6px;background:#2a244e}
  .thumb .title{font-size:14px}
  .thumb .id{font-size:11px;color:var(--muted)}
  .thumb[draggable="true"]{cursor:grab}
  .thumb.dragging{opacity:.5}
  .rowtools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
  .inline-note{font-size:12px;color:var(--muted);margin-left:8px}
  .pill{display:inline-flex;align-items:center;gap:8px;background:#1c1837;border:1px solid var(--border);border-radius:999px;padding:6px 10px;color:#dcd8ff}
  .pill input{margin-right:4px}
  .pill .x{cursor:pointer;color:#ffb4b4}
  input[type="text"]{background:#1c1837;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px;width:100%}
  .row{display:grid;gap:10px;grid-template-columns:1fr 100px}
  .mini{font-size:12px}
</style>
</head><body>
<div class="wrap">
  <div class="hero">
    <h1>My Lists – Admin</h1>
    <div class="subtitle">Last sync: ${lastSyncText}</div>
  </div>

  <div class="grid">
    <div class="card">
      <h3>Current Snapshot</h3>
      <ul>${rows}</ul>
      <div class="rowtools">
        <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}"><button class="btn2">Sync IMDb Lists Now</button></form>
        <form method="POST" action="/api/purge-sync?admin=${ADMIN_PASSWORD}" onsubmit="return confirm('Purge caches & re-sync?')"><button>🧹 Purge & Sync</button></form>
        <span class="inline-note">Auto-sync every <b>${IMDB_SYNC_MINUTES}</b> min.</span>
      </div>
      <h4>Manifest URL</h4>
      <p class="code">${manifestUrl}</p>
      <p class="mini muted">Version bumps automatically when catalogs change.</p>
    </div>

    <div class="card">
      <h3>Discovered & Sources</h3>
      <div style="margin-top:8px">
  <div class="mini muted">Blocked lists (won't re-add on sync):</div>
  <div id="blockedPills"></div>
</div>

      <p class="mini muted">We merge your main user (+ extras) and explicit list URLs/IDs. Remove will also block the list (no re-add on next sync).</p>

      <div class="row">
        <div><label>Add IMDb <b>User /lists</b> URL</label>
          <input id="userInput" placeholder="https://www.imdb.com/user/urXXXXXXX/lists/" />
        </div>
        <div><button id="addUser">Add</button></div>
      </div>
      <div class="row">
        <div><label>Add IMDb <b>List</b> URL or ID (ls…)</label>
          <input id="listInput" placeholder="https://www.imdb.com/list/ls123456789/ or ls123456789" />
        </div>
        <div><button id="addList">Add</button></div>
      </div>

      <div style="margin-top:10px">
        <div class="mini muted">Your extra users:</div>
        <div id="userPills"></div>
      </div>
      <div style="margin-top:8px">
        <div class="mini muted">Your extra lists:</div>
        <div id="listPills"></div>
      </div>

      <h4 style="margin-top:14px">Discovered</h4>
      <ul>${disc}</ul>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <h3>Customize (enable/disable, order, defaults)</h3>
    <p class="muted">Drag rows to change list order. Click ▾ to open a list: drag posters for a <b>custom</b> order, and pick which <b>sort options</b> appear in Stremio.</p>
    <div id="prefs"></div>
  </div>

</div>

<script>
const ADMIN="${ADMIN_PASSWORD}";
const SORT_OPTIONS = ${JSON.stringify(SORT_OPTIONS)};

async function getPrefs(){ const r = await fetch('/api/prefs?admin='+ADMIN); return r.json(); }
async function getLists(){ const r = await fetch('/api/lists?admin='+ADMIN); return r.json(); }
async function getListItems(lsid){ const r = await fetch('/api/list-items?admin='+ADMIN+'&lsid='+encodeURIComponent(lsid)); return r.json(); }
async function saveCustomOrder(lsid, order){
  const r = await fetch('/api/custom-order?admin='+ADMIN, {method:'POST',headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid, order })});
  if (!r.ok) throw new Error('save failed');
  return r.json();
}

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
function isCtrl(node){
  const t = (node && node.tagName || "").toLowerCase();
  return t === "input" || t === "select" || t === "button" || t === "a" || t === "label" || t === "textarea";
}

// Row drag (table tbody)
function attachRowDnD(tbody) {
  let dragSrc = null;
  tbody.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr[data-lsid]');
    if (!tr || isCtrl(e.target)) return;
    dragSrc = tr;
    tr.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tr.dataset.lsid || '');
  });
  tbody.addEventListener('dragend', () => { if (dragSrc) dragSrc.classList.remove('dragging'); dragSrc = null; });
  tbody.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragSrc) return;
    const over = e.target.closest('tr[data-lsid]');
    if (!over || over === dragSrc) return;
    const rect = over.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    over.parentNode.insertBefore(dragSrc, before ? over : over.nextSibling);
  });
}

// Thumb drag (ul.thumbs)
function attachThumbDnD(ul) {
  let src = null;
  ul.addEventListener('dragstart', (e)=>{
    const li = e.target.closest('li.thumb'); if (!li) return;
    src = li; li.classList.add('dragging');
    e.dataTransfer.effectAllowed='move';
    e.dataTransfer.setData('text/plain', li.dataset.id || '');
  });
  ul.addEventListener('dragend', ()=>{ if(src){src.classList.remove('dragging'); src=null;} });
  ul.addEventListener('dragover', (e)=>{
    e.preventDefault();
    if (!src) return;
    const over = e.target.closest('li.thumb'); if (!over || over===src) return;
    const rect = over.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height/2;
    over.parentNode.insertBefore(src, before ? over : over.nextSibling);
  });
}

async function render() {
  const prefs = await getPrefs();
  const lists = await getLists();

  // sources pills
  function renderPills(id, arr, onRemove){
    const wrap = document.getElementById(id); wrap.innerHTML = '';
    (arr||[]).forEach((txt, idx)=>{
      const pill = el('span', {class:'pill'}, [
        el('span',{text:txt}),
        el('span',{class:'x',text:'✕'})
      ]);
      pill.querySelector('.x').onclick = ()=> onRemove(idx);
      wrap.appendChild(pill);
      wrap.appendChild(document.createTextNode(' '));
    });
    if (!arr || !arr.length) wrap.textContent = '(none)';
  }
  renderPills('userPills', prefs.sources?.users || [], (i)=>{
    prefs.sources.users.splice(i,1);
    saveAll('Saved'); // silent save
  });
  renderPills('listPills', prefs.sources?.lists || [], (i)=>{
    prefs.sources.lists.splice(i,1);
    saveAll('Saved');
  });
  
// >>> INSERTED BLOCK: Blocked pills with Unblock action
{
const blockedWrap = document.getElementById('blockedPills');
blockedWrap.innerHTML = '';
const blocked = prefs.blocked || [];
if (!blocked.length) blockedWrap.textContent = '(none)';
blocked.forEach(lsid=>{
const pill = el('span',{class:'pill'},[
el('span',{text:lsid}),
el('span',{class:'x',text:' Unblock'})
]);
pill.querySelector('.x').onclick = async ()=>{
await fetch('/api/unblock-list?admin='+ADMIN, {
method:'POST', headers:{'Content-Type':'application/json'},
body: JSON.stringify({ lsid })
});
location.reload();
};
blockedWrap.appendChild(pill);
blockedWrap.appendChild(document.createTextNode(' '));
});
}
// <<< END INSERTED BLOCK

  document.getElementById('addUser').onclick = async (e)=>{
    e.preventDefault();
    const v = document.getElementById('userInput').value.trim();
    if (!v) return;
    prefs.sources = prefs.sources || {users:[],lists:[]};
    if (!prefs.sources.users.includes(v)) prefs.sources.users.push(v);
    document.getElementById('userInput').value = '';
    await saveAll('Added user');
  };
  document.getElementById('addList').onclick = async (e)=>{
    e.preventDefault();
    const v = document.getElementById('listInput').value.trim();
    if (!v) return;
    prefs.sources = prefs.sources || {users:[],lists:[]};
    if (!prefs.sources.lists.includes(v)) prefs.sources.lists.push(v);
    document.getElementById('listInput').value = '';
    await saveAll('Added list');
  };

  const container = document.getElementById('prefs'); container.innerHTML = "";

  const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));
  const baseOrder = (prefs.order && prefs.order.length ? prefs.order.filter(id => lists[id]) : []);
  const missing   = Object.keys(lists).filter(id => !baseOrder.includes(id))
    .sort((a,b)=>( (lists[a]?.name||a).localeCompare(lists[b]?.name||b) ));
  const order = baseOrder.concat(missing);

  const table = el('table');
  const thead = el('thead', {}, [el('tr',{},[
    el('th',{text:''}), el('th',{text:'Enabled'}), el('th',{text:'List (lsid)'}), el('th',{text:'Items'}),
    el('th',{text:'Default sort'}), el('th',{text:'Remove'})
  ])]);
  table.appendChild(thead);
  const tbody = el('tbody');

  function makeDrawer(lsid) {
    const tr = el('tr',{class:'drawer', 'data-drawer-for':lsid});
    const td = el('td',{colspan:'6'});
    td.appendChild(el('div',{text:'Loading…'}));
    tr.appendChild(td);
    getListItems(lsid).then(({items})=>{
      td.innerHTML = '';

      // tools line: save/reset + sort options checkboxes
      const tools = el('div', {class:'rowtools'});
      const saveBtn = el('button',{text:'Save order'});
      const resetBtn = el('button',{text:'Reset order'});
      tools.appendChild(saveBtn); tools.appendChild(resetBtn);

      // sort options visible
      const optsWrap = el('div',{class:'rowtools'});
      optsWrap.appendChild(el('span',{class:'mini muted', text:'Sort options shown in Stremio:'}));
      const current = (prefs.sortOptions && prefs.sortOptions[lsid] && prefs.sortOptions[lsid].length) ? new Set(prefs.sortOptions[lsid]) : new Set(SORT_OPTIONS);
      SORT_OPTIONS.forEach(opt=>{
        const lab = el('label',{class:'pill'});
        const cb = el('input',{type:'checkbox'}); cb.checked = current.has(opt);
        cb.onchange = ()=>{
          const arr = Array.from(optsWrap.querySelectorAll('input')).map((c,i)=>c.checked?SORT_OPTIONS[i]:null).filter(Boolean);
          prefs.sortOptions = prefs.sortOptions || {};
          prefs.sortOptions[lsid] = arr.length ? arr : SORT_OPTIONS.slice();
        };
        lab.appendChild(cb);
        lab.appendChild(el('span',{text:opt}));
        optsWrap.appendChild(lab);
      });

      td.appendChild(tools);
      td.appendChild(optsWrap);

      const ul = el('ul',{class:'thumbs'});
      let ordered = items.slice();
      const co = (prefs.customOrder && prefs.customOrder[lsid]) || [];
      if (co && co.length) {
        const pos = new Map(co.map((id,i)=>[id,i]));
        ordered.sort((a,b)=>{
          const pa = pos.has(a.id) ? pos.get(a.id) : 1e9;
          const pb = pos.has(b.id) ? pos.get(b.id) : 1e9;
          return pa - pb;
        });
      }
      for (const it of ordered) {
        const li = el('li',{class:'thumb','data-id':it.id,draggable:'true'});
        const img = el('img',{src: it.poster || '', alt:''});
        const wrap = el('div',{},[
          el('div',{class:'title',text: it.name || it.id}),
          el('div',{class:'id',text: it.id})
        ]);
        li.appendChild(img); li.appendChild(wrap);
        ul.appendChild(li);
      }
      td.appendChild(ul);
      attachThumbDnD(ul);

      saveBtn.onclick = async ()=>{
        const ids = Array.from(ul.querySelectorAll('li.thumb')).map(li=>li.getAttribute('data-id'));
        saveBtn.disabled = true; resetBtn.disabled = true;
        try {
          await saveCustomOrder(lsid, ids);
          saveBtn.textContent = "Saved ✓";
          setTimeout(()=> saveBtn.textContent = "Save order", 1500);
        } catch(e) {
          alert("Failed to save custom order");
        } finally {
          saveBtn.disabled = false; resetBtn.disabled = false;
        }
      };
      resetBtn.onclick = ()=>{
        ul.innerHTML = '';
        for (const it of items) {
          const li = el('li',{class:'thumb','data-id':it.id,draggable:'true'});
          li.appendChild(el('img',{src: it.poster || '', alt:''}));
          const wrap = el('div',{},[
            el('div',{class:'title',text: it.name || it.id}),
            el('div',{class:'id',text: it.id})
          ]);
          li.appendChild(wrap);
          ul.appendChild(li);
        }
        attachThumbDnD(ul);
      };
    }).catch(()=>{ td.textContent = "Failed to load items."; });
    return tr;
  }

  function removeList(lsid){
    if (!confirm('Remove this list and block it from reappearing?')) return;
    fetch('/api/remove-list?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid })})
      .then(()=> location.reload())
      .catch(()=> alert('Remove failed'));
  }

  function makeRow(lsid) {
    const L = lists[lsid];
    const tr = el('tr', {'data-lsid': lsid, draggable:'true'});

    const chev = el('span',{class:'chev',text:'▾', title:'Open custom order & sort options'});
    const chevTd = el('td',{},[chev]);

    const cb = el('input', {type:'checkbox'}); cb.checked = enabledSet.has(lsid);
    cb.addEventListener('change', ()=>{ if (cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); });

    const nameCell = el('td',{}); 
    nameCell.appendChild(el('div',{text:(L.name||lsid)}));
    nameCell.appendChild(el('small',{text:lsid}));

    const count = el('td',{text:String((L.ids||[]).length)});

    const sortSel = el('select');
    SORT_OPTIONS.forEach(o=>{
      const opt = el('option',{value:o,text:o});
      const def = (prefs.perListSort && prefs.perListSort[lsid]) || "name_asc";
      if (o===def) opt.setAttribute('selected','');
      sortSel.appendChild(opt);
    });
    sortSel.addEventListener('change', ()=>{ prefs.perListSort = prefs.perListSort || {}; prefs.perListSort[lsid] = sortSel.value; });

    const rmBtn = el('button',{text:'Remove'});
    rmBtn.onclick = ()=> removeList(lsid);

    tr.appendChild(chevTd);
    tr.appendChild(el('td',{},[cb]));
    tr.appendChild(nameCell);
    tr.appendChild(count);
    tr.appendChild(el('td',{},[sortSel]));
    tr.appendChild(el('td',{},[rmBtn]));

    // drawer handling
    let drawer = null; let open = false;
    chev.onclick = ()=>{
      open = !open;
      if (open) {
        chev.textContent = "▴";
        if (!drawer) {
          drawer = makeDrawer(lsid);
          tr.parentNode.insertBefore(drawer, tr.nextSibling);
        } else {
          drawer.style.display = "";
        }
      } else {
        chev.textContent = "▾";
        if (drawer) drawer.style.display = "none";
      }
    };

    return tr;
  }

  order.forEach(lsid => tbody.appendChild(makeRow(lsid)));
  table.appendChild(tbody);
  attachRowDnD(tbody);

  container.appendChild(table);

  const saveWrap = el('div',{style:'margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap'});
  const saveBtn = el('button',{text:'Save'});
  const msg = el('span',{class:'inline-note'});
  saveWrap.appendChild(saveBtn); saveWrap.appendChild(msg);
  container.appendChild(saveWrap);

  async function saveAll(text){
    const newOrder = Array.from(tbody.querySelectorAll('tr[data-lsid]')).map(tr => tr.getAttribute('data-lsid'));
    const enabled = Array.from(enabledSet);
    const body = {
      enabled,
      order: newOrder,
      defaultList: prefs.defaultList || (enabled[0] || ""),
      perListSort: prefs.perListSort || {},
      sortOptions: prefs.sortOptions || {},
      upgradeEpisodes: prefs.upgradeEpisodes || false,
      sources: prefs.sources || {},
      blocked: prefs.blocked || []
    };
    msg.textContent = "Saving…";
    const r = await fetch('/api/prefs?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    const t = await r.text();
    msg.textContent = text || t || "Saved.";
    setTimeout(()=>{ msg.textContent = ""; }, 1800);
  }

  saveBtn.onclick = ()=> saveAll();
}

render();
</script>
</body></html>`);
});

// ----------------- BOOT -----------------
(async () => {
  try {
    const snap = await loadSnapshot();
    if (snap) {
      LISTS = snap.lists || LISTS;
      PREFS = { ...PREFS, ...(snap.prefs || {}) };
      FALLBK.clear(); if (snap.fallback) for (const [k,v] of Object.entries(snap.fallback)) FALLBK.set(k, v);
      CARD.clear();   if (snap.cards)    for (const [k,v] of Object.entries(snap.cards))    CARD.set(k, v);
      EP2SER.clear(); if (snap.ep2ser)   for (const [k,v] of Object.entries(snap.ep2ser))   EP2SER.set(k, v);
      MANIFEST_REV = snap.manifestRev || MANIFEST_REV;
      LAST_SYNC_AT = snap.lastSyncAt || 0;
      LAST_MANIFEST_KEY = manifestKey();
      console.log("[BOOT] snapshot loaded");
    }
  } catch(e){ console.warn("[BOOT] load snapshot failed:", e.message); }

  fullSync({ rediscover: true }).then(()=> scheduleNextSync()).catch(e => {
    console.warn("[BOOT] background sync failed:", e.message);
  });

  app.listen(PORT, HOST, () => {
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
  });
})();
