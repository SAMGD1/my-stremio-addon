
/*  My Lists – Public Generator (IMDb → Stremio)
 *  Multi-tenant: each user gets a personal "workspace" by pasting an IMDb user/list URL.
 *  Admin UI reuses the same look & features (custom order, per-list sort, add by tt..., sync).
 *  v13.0.0
 */
"use strict";

const express = require("express");
const fs = require("fs/promises");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ----------------- ENV -----------------
const PORT  = Number(process.env.PORT || 7000);
const HOST  = "0.0.0.0";

// PUBLIC MODE is always on for this build
const PUBLIC_MODE = true;

// GitHub snapshot storage (same repo you already use)
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || "";
const GITHUB_OWNER  = process.env.GITHUB_OWNER  || "";
const GITHUB_REPO   = process.env.GITHUB_REPO   || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GH_ENABLED    = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

// We store global (legacy) at data/snapshot.json and per-user at users/<uid>/snapshot.json
const SNAP_LOCAL = "data/snapshot.json";
const USERS_DIR  = "users";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/13.0";
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};
const CINEMETA = "https://v3-cinemeta.strem.io";

// include "imdb" (raw list order) and mirror IMDb’s release-date order when available
const SORT_OPTIONS = [
  "custom","imdb",
  "date_asc","date_desc",
  "rating_asc","rating_desc",
  "runtime_asc","runtime_desc",
  "name_asc","name_desc"
];
const VALID_SORT = new Set(SORT_OPTIONS);

// ----------------- STATE (per-request; we use a context swap) -----------------
/**
 * We reuse the same in-memory structures as your original code, but we "load" a user's snapshot
 * into these globals for the duration of a request and then restore them.
 */
let LISTS   = Object.create(null);         // { [lsid]: { id,name,url, ids:[tt...], orders:{ imdb, date_asc, date_desc } } }
let PREFS   = { enabled:[], order:[], perListSort:{}, sortOptions:{}, customOrder:{} };
let FALLBK  = new Map();                   // Map<tt, {name,poster,releaseDate,year,type}>
let CARD    = new Map();                   // Map<tt, card>
let EP2SER  = new Map();                   // Map<episode tt -> series tt>
let BEST    = new Map();                   // Map<tt, {kind:'movie'|'series', meta: {...}}>

let LAST_SYNC_AT = 0;
let MANIFEST_REV = 1;
let LAST_MANIFEST_KEY = "";

// ----------------- UTILS -----------------
const isImdb   = v => /^tt\d{7,}$/i.test(String(v||""));
const isListId = v => /^ls\d{6,}$/i.test(String(v||""));
const minutes  = ms => Math.round(ms/60000);
const sleep    = ms => new Promise(r => setTimeout(r, ms));
const clampSortOptions = arr => (Array.isArray(arr) ? arr.filter(x => VALID_SORT.has(x)) : []);

function rand(n=18){ return crypto.randomBytes(n).toString("base64url"); }
function baseUrl(req){
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return `${proto}://${host}`;
}

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

// ---------- GitHub helpers ----------
async function gh(method, path, bodyObj) {
  if (!GH_ENABLED) throw new Error("GitHub not configured");
  const url = `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}${path}`;
  const headers = {
    "User-Agent": UA,
    "Authorization": `token ${GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json"
  };
  const opt = { method, headers };
  if (bodyObj) opt.body = JSON.stringify(bodyObj);
  const r = await fetch(url, opt);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${method} ${path} -> ${r.status}: ${t}`);
  }
  return r.json();
}
async function ghGetSha(path) {
  try {
    const d = await gh("GET", `/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    return d.sha;
  } catch { return null; }
}
async function ghReadJson(path) {
  if (!GH_ENABLED) return null;
  try {
    const d = await gh("GET", `/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    const raw = Buffer.from(d.content, "base64").toString("utf8");
    return JSON.parse(raw);
  } catch { return null; }
}
async function ghWriteJson(path, obj, message) {
  if (!GH_ENABLED) return;
  const sha = await ghGetSha(path);
  const body = {
    message: message || `Update ${path}`,
    content: Buffer.from(JSON.stringify(obj, null, 2)).toString("base64"),
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;
  await gh("PUT", `/contents/${encodeURIComponent(path)}`, body);
}

// ---------- Snapshot load/save (global or per-user) ----------
async function saveSnapshot(obj, uid) {
  // decide path
  if (uid) {
    await ghWriteJson(`${USERS_DIR}/${uid}/snapshot.json`, obj, `Update user ${uid} snapshot`);
    // also write meta timestamps
    const metaOld = await ghReadJson(`${USERS_DIR}/${uid}/meta.json`) || {};
    const metaNew = { ...metaOld, updatedAt: Date.now(), createdAt: metaOld.createdAt || Date.now() };
    await ghWriteJson(`${USERS_DIR}/${uid}/meta.json`, metaNew, `Update user ${uid} meta`);
    return;
  }
  // legacy global path
  if (GH_ENABLED) {
    await ghWriteJson("data/snapshot.json", obj, "Update snapshot.json");
  } else {
    await fs.mkdir("data", { recursive: true });
    await fs.writeFile(SNAP_LOCAL, JSON.stringify(obj, null, 2));
  }
}
async function loadSnapshot(uid) {
  if (uid) {
    // per-user
    const j = await ghReadJson(`${USERS_DIR}/${uid}/snapshot.json`);
    return j || null;
  }
  if (GH_ENABLED) {
    return await ghReadJson("data/snapshot.json");
  } else {
    try {
      const txt = await fs.readFile(SNAP_LOCAL, "utf8");
      return JSON.parse(txt);
    } catch { return null; }
  }
}

// ---------- IMDb discovery & parsing ----------
function normalizeListIdOrUrl(s) {
  if (!s) return null;
  s = String(s).trim();
  const m = s.match(/ls\d{6,}/i);
  if (m) return `https://www.imdb.com/list/${m[0]}/`;
  try {
    const u = new URL(s);
    if (/imdb\.com\/list\//i.test(u.href)) return `https://www.imdb.com/list/${(u.pathname.match(/ls\d{6,}/)||[""])[0]}/`;
    return null;
  } catch { return null; }
}
async function discoverFromUserLists(userListsUrl) {
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
  let url = listUrl; const ids = []; const seen = new Set(); let pages = 0;
  while (url && pages < maxPages) {
    const html = await fetchText(withParam(url, "_", Date.now()));
    const pageIds = tconstsFromHtml(html);
    for (const tt of pageIds) if (!seen.has(tt)) { seen.add(tt); ids.push(tt); }
    url = nextPageUrl(html); pages += 1;
    await sleep(60);
  }
  return ids;
}

// ---------- Cinemeta & IMDb JSON-LD ----------
async function fetchCinemeta(kind, imdbId) {
  try {
    const url = `${CINEMETA}/${kind}/${imdbId}.json`;
    const j = await fetchJson(url);
    if (!j || !j.meta) return null;
    return j.meta;
  } catch { return null; }
}
async function imdbJsonLd(imdbId) {
  try {
    const url = `https://www.imdb.com/title/${imdbId}/`;
    const html = await fetchText(withParam(url, "_", Date.now()));
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (!m) return null;
    return JSON.parse(m[1]);
  } catch { return null; }
}
async function getSeriesForEpisode(imdbId) {
  let seriesId = null;
  try {
    const ld = await imdbJsonLd(imdbId);
    if (!ld) return null;
    const node = Array.isArray(ld && ld["@graph"])
      ? ld["@graph"].find(x => x["@id"]?.includes(`/title/${imdbId}`)) || ld["@graph"][0]
      : ld;
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
function cardFor(imdbId){
  const r = BEST.get(imdbId);
  if (r && r.meta) return { id: imdbId, type: r.kind, name: r.meta.name, poster: r.meta.poster, releaseInfo: r.meta.released || r.meta.releaseInfo, year: r.meta.year };
  const fb = FALLBK.get(imdbId) || {};
  return { id: imdbId, type: (r && r.kind) || fb.type || "movie", name: fb.name || imdbId, poster: fb.poster, releaseInfo: fb.releaseDate || undefined, year: fb.year };
}

// ---------- Sorting ----------
function toTs(d,y){ if(d){const t=Date.parse(d); if(!Number.isNaN(t)) return t;} if(y){const t=Date.parse(String(y)+'-01-01'); if(!Number.isNaN(t)) return t;} return null; }
function stableSort(items, sortKey){
  const s = String(sortKey||'name_asc').toLowerCase();
  const dir = s.endsWith('_asc') ? 1 : -1;
  const key = s.split('_')[0];
  const cmpNullBottom = (a,b) => (a==null && b==null)?0 : (a==null?1 : (b==null?-1 : (a<b?-1:(a>b?1:0))));
  return items.map((m,i)=>({m,i})).sort((A,B)=>{
    const a=A.m,b=B.m; let c=0;
    if (key==='name') c = cmpNullBottom(String(a.name||'').toLowerCase(), String(b.name||'').toLowerCase());
    else if (key==='rating') c = cmpNullBottom(a.imdbRating, b.imdbRating);
    else if (key==='runtime') c = cmpNullBottom(a.runtime, b.runtime);
    else if (key==='date') { const ta = toTs(a.releaseInfo||a.released||a.releaseDate||null, a.year); const tb = toTs(b.releaseInfo||b.released||b.releaseDate||null, b.year); c = cmpNullBottom(ta,tb); }
    else c = cmpNullBottom(String(a.name||'').toLowerCase(), String(b.name||'').toLowerCase());
    if (c===0) c = A.i - B.i;
    return c*dir;
  }).map(x=>x.m);
}

// ---------- Build catalogs from LISTS/PREFS ----------
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
    type: "my lists",
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
function listMetas(lsid, extra){
  const list = LISTS[lsid]; if (!list) return [];
  const q = String(extra.search||"").toLowerCase().trim();
  const sortReq = String(extra.sort||"").toLowerCase();
  const defSort = (PREFS.perListSort && PREFS.perListSort[lsid]) || "name_asc";
  const sort = sortReq || defSort;

  let ids = (list.ids || []).slice();
  const ed = (PREFS.listEdits && PREFS.listEdits[lsid]) || {};
  const removed = new Set((ed.removed || []).filter(isImdb));
  if (removed.size) ids = ids.filter(tt => !removed.has(tt));
  const toAdd = (ed.added || []).filter(isImdb);
  for (const tt of toAdd) if (!ids.includes(tt)) ids.push(tt);

  let metas = ids.map(tt => CARD.get(tt) || cardFor(tt));
  if (q) metas = metas.filter(m =>
    (m.name||"").toLowerCase().includes(q) ||
    (m.id||"").toLowerCase().includes(q) ||
    (m.description||"").toLowerCase().includes(q)
  );

  if (sort === "custom" && PREFS.customOrder && Array.isArray(PREFS.customOrder[lsid]) && PREFS.customOrder[lsid].length){
    const pos = new Map(PREFS.customOrder[lsid].map((id,i)=>[id,i]));
    metas = metas.slice().sort((a,b)=> (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  } else if (sort === "imdb") {
    const imdbIndex = new Map((list.ids || []).map((id,i)=>[id,i]));
    metas = metas.slice().sort((a,b)=> (imdbIndex.get(a.id) ?? 1e9) - (imdbIndex.get(b.id) ?? 1e9));
  } else if ((sort === "date_asc" || sort === "date_desc") && list.orders && Array.isArray(list.orders[sort]) && list.orders[sort].length) {
    const pos = new Map(list.orders[sort].map((id,i)=>[id,i]));
    metas = metas.slice().sort((a,b)=> (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  } else {
    metas = stableSort(metas, sort);
  }
  return metas;
}

// ---------- Sync ----------
function manifestKey() {
  const enabled = (PREFS.enabled && PREFS.enabled.length) ? PREFS.enabled : Object.keys(LISTS);
  const names = enabled.map(id => LISTS[id]?.name || id).sort().join("|");
  const perSort = JSON.stringify(PREFS.perListSort || {});
  const perOpts = JSON.stringify(PREFS.sortOptions || {});
  const custom = Object.keys(PREFS.customOrder || {}).length;
  const order = (PREFS.order || []).join(",");
  return `${enabled.join(",")}#${order}#${PREFS.defaultList||""}#${names}#${perSort}#${perOpts}#c${custom}`;
}

async function harvestSources() {
  const discovered = [];
  const users = Array.from(new Set((PREFS.sources?.users || []).map(s => String(s).trim()).filter(Boolean)));
  for (const u of users) {
    try { discovered.push(...await discoverFromUserLists(u)); }
    catch(e){ console.warn("[DISCOVER] user", u, "failed:", e.message); }
    await sleep(80);
  }
  const addlRaw = (PREFS.sources?.lists || []);
  for (const raw of addlRaw) {
    const u = normalizeListIdOrUrl(raw);
    if (u) {
      const id = (u.match(/ls\d{6,}/i)||[""])[0];
      try {
        const name = await fetchListName(u);
        discovered.push({ id, url:u, name });
      } catch {
        discovered.push({ id, url:u, name: id });
      }
    }
    await sleep(50);
  }
  const ids = new Map();
  for (const it of discovered) if (it.id) ids.set(it.id, it);
  return Array.from(ids.values());
}

async function fullSync({ rediscover=false } = {}) {
  if (!PREFS.sources) PREFS.sources = { users:[], lists:[] };
  const sourceLists = rediscover ? await harvestSources() : [];
  const next = Object.create(null);
  const idsToPreload = new Set();

  for (const L of sourceLists) {
    try {
      const rawIds = await fetchImdbListIdsAllPages(L.url);
      next[L.id] = { id: L.id, name: L.name || L.id, url: L.url, ids: rawIds.slice(), orders: {} };
      for (const tt of rawIds.slice(0, 50)) idsToPreload.add(tt);
    } catch(e) {
      console.warn("[SYNC] list", L.id, "failed:", e.message);
    }
    await sleep(120);
  }

  // carry old lists if present and no rediscover
  if (!rediscover) {
    for (const id of Object.keys(LISTS)) if (!next[id]) next[id] = LISTS[id];
  }

  // Episode→Series upgrade
  const seen = new Set();
  for (const id of Object.keys(next)) {
    const raw = (next[id].ids || []).slice();
    for (let i=0;i<raw.length;i++){
      const tt = raw[i];
      if (seen.has(tt)) continue;
      const meta = await getBestMeta(tt);
      if (!meta || meta.kind !== "episode") continue;
      const ser = await getSeriesForEpisode(tt);
      if (ser) { raw[i] = ser; seen.add(ser); }
      await sleep(10);
    }
    // de-dupe
    const uniq = []; const S = new Set();
    for (const x of raw) { if (!S.has(x)) { S.add(x); uniq.push(x); } }
    next[id].ids = uniq;
    next[id].orders = next[id].orders || {};
    next[id].orders.imdb = uniq.slice();
  }

  // Preload few cards
  for (const tt of Array.from(idsToPreload)) { await getBestMeta(tt); CARD.set(tt, cardFor(tt)); }

  LISTS = next;
  LAST_SYNC_AT = Date.now();
  const mk = manifestKey();
  if (mk !== LAST_MANIFEST_KEY) { MANIFEST_REV += 1; LAST_MANIFEST_KEY = mk; }

  await saveSnapshot({
    lastSyncAt: LAST_SYNC_AT,
    manifestRev: MANIFEST_REV,
    lists: LISTS,
    prefs: PREFS,
    fallback: Object.fromEntries(FALLBK),
    cards: Object.fromEntries(CARD),
    ep2ser: Object.fromEntries(EP2SER)
  }, currentUid());
}

// ---------- Workspace (per-user) context swap ----------
let __CURRENT_UID = null;
function currentUid(){ return __CURRENT_UID; }
async function applySnapshotFor(uid){
  __CURRENT_UID = uid;
  const snap = await loadSnapshot(uid);
  if (!snap) { // first-time
    LISTS = Object.create(null);
    PREFS = { enabled:[], order:[], perListSort:{}, sortOptions:{}, customOrder:{}, sources:{users:[],lists:[]}, blocked:[] };
    FALLBK = new Map(); CARD = new Map(); EP2SER = new Map(); BEST = new Map();
    LAST_SYNC_AT = 0; MANIFEST_REV = 1; LAST_MANIFEST_KEY = "";
  } else {
    LISTS = snap.lists || Object.create(null);
    PREFS = { enabled:[], order:[], perListSort:{}, sortOptions:{}, customOrder:{}, ...(snap.prefs||{}) };
    FALLBK = new Map(Object.entries(snap.fallback || {}));
    CARD   = new Map(Object.entries(snap.cards || {}));
    EP2SER = new Map(Object.entries(snap.ep2ser || {}));
    BEST   = new Map();
    LAST_SYNC_AT = snap.lastSyncAt || 0;
    MANIFEST_REV = snap.manifestRev || 1;
    LAST_MANIFEST_KEY = manifestKey();
  }
}
async function persistCurrent(){
  await saveSnapshot({
    lastSyncAt: LAST_SYNC_AT,
    manifestRev: MANIFEST_REV,
    lists: LISTS,
    prefs: PREFS,
    fallback: Object.fromEntries(FALLBK),
    cards: Object.fromEntries(CARD),
    ep2ser: Object.fromEntries(EP2SER)
  }, currentUid());
}
function clearWorkspace(){ __CURRENT_UID = null; }

// Middleware: mount per-user workspace for /u/:uid/*
app.use('/u/:uid', async (req,res,next)=>{
  try{
    await applySnapshotFor(req.params.uid);
    res.on('finish', () => { clearWorkspace(); });
    next();
  }catch(e){ console.error(e); res.status(500).send("Workspace error"); }
});

// ---------- Landing (public generator) ----------
app.get("/", (req,res)=>{
  const b = baseUrl(req);
  res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>My Lists – Public Generator</title>
  <style>
    body{font-family:system-ui;margin:0;background:#0f0d1a;color:#f7f7fb}
    .wrap{max-width:880px;margin:42px auto;padding:0 16px}
    .card{background:#15122b;border:1px solid #2a2650;border-radius:14px;padding:18px}
    input,textarea{width:100%;background:#1c1837;color:#fff;border:1px solid #2a2650;border-radius:10px;padding:10px}
    button{background:#6c5ce7;color:#fff;border:0;border-radius:10px;padding:12px 16px;cursor:pointer}
    small{color:#9aa0b4}
  </style>
  <div class="wrap">
    <h1>My Lists – Generate Your Add-on</h1>
    <div class="card">
      <p>Paste an IMDb <b>User /lists</b> URL or one/more <b>List</b> URLs/IDs. We’ll make a personal add-on for you.</p>
      <form method="POST" action="/api/create">
        <label>User /lists URL</label>
        <input name="userUrl" placeholder="https://www.imdb.com/user/urXXXXXXX/lists/" />
        <div style="height:10px"></div>
        <label>List URLs/IDs (optional, one per line)</label>
        <textarea name="lists" rows="4" placeholder="ls123..., https://www.imdb.com/list/ls123..."></textarea>
        <div style="height:12px"></div>
        <button>Generate Add-on</button>
        <div style="height:6px"></div>
        <small>We’ll sync the lists, give you a manifest URL and an admin page to customize.</small>
      </form>
    </div>
  </div>`);
});

app.post("/api/create", express.urlencoded({extended:true}), async (req,res)=>{
  try{
    const userUrl = String(req.body.userUrl||"").trim();
    const listsRaw = String(req.body.lists||"").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if (!userUrl && !listsRaw.length) return res.status(400).send("Provide a user /lists URL or at least one list URL/ID.");

    const uid = rand(10); // uid is also the admin key
    await applySnapshotFor(uid);
    PREFS.sources = { users: userUrl ? [userUrl] : [], lists: listsRaw };
    await persistCurrent(); // create files
    // initial sync in background
    fullSync({ rediscover:true }).catch(()=>{});

    const b = baseUrl(req);
    const adminUrl = `${b}/u/${uid}/admin?key=${uid}`;
    const manifestUrl = `${b}/u/${uid}/manifest.json`;

    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Your add-on</title><style>body{font-family:system-ui;background:#0f0d1a;color:#f7f7fb;padding:24px}</style>
      <h2>All set!</h2>
      <p><b>Admin page:</b> <a href="${adminUrl}">${adminUrl}</a></p>
      <p><b>Manifest URL:</b> <span style="font-family:monospace">${manifestUrl}</span></p>
      <p><a href="https://web.stremio.com/#/addons/3rdparty/add?addon=${encodeURIComponent(manifestUrl)}">Install in Stremio</a></p>`);
  }catch(e){ console.error(e); res.status(500).send("Failed to create workspace"); }
});

// ---------- Per-user Admin (reuses existing UI with API_BASE) ----------
app.get("/u/:uid/admin", async (req,res)=>{
  const uid = req.params.uid;
  const key = String(req.query.key||"");
  if (key !== uid) return res.status(403).send("Forbidden. Missing or wrong ?key.");
  await applySnapshotFor(uid);
  const b = baseUrl(req);
  const lastSyncText = LAST_SYNC_AT ? (new Date(LAST_SYNC_AT).toLocaleString() + " (" + Math.round((Date.now()-LAST_SYNC_AT)/60000) + " min ago)") : "never";
  const manifestUrl = `${b}/u/${uid}/manifest.json`;

  // Minimal admin page (client fetches everything)
  res.type("html").send(`<!doctype html>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>My Lists – Admin</title>
  <style>
  :root{color-scheme:light; --bg:#0f0d1a; --card:#15122b; --muted:#9aa0b4; --text:#f7f7fb; --accent:#6c5ce7; --accent2:#8b7cf7; --border:#2a2650}
  body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:0;background:linear-gradient(180deg,#141126 0%,#0f0d1a 100%);color:var(--text)}
  .wrap{max-width:1100px;margin:24px auto;padding:0 16px}
  .card{border:1px solid var(--border);border-radius:14px;padding:16px;background:var(--card);box-shadow:0 8px 24px rgba(0,0,0,.28)}
  button{padding:10px 16px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
  .btn2{background:var(--accent2)}
  small{color:var(--muted)}
  .row{display:flex;gap:10px;align-items:center}
  .mini{font-size:12px}
  .code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#1c1837;color:#d6d3ff;padding:4px 6px;border-radius:6px}
  table{width:100%;border-collapse:collapse} th,td{padding:10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
  .thumbs{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
  .thumb{background:#1c1837;border:1px solid #2a2650;border-radius:12px;padding:8px;display:flex;gap:10px;align-items:center}
  .thumb img{width:54px;height:80px;object-fit:cover;border-radius:8px}
  .pill{display:inline-flex;align-items:center;gap:6px;border:1px solid #2a2650;border-radius:100px;padding:6px 10px;margin-right:6px}
  .pill input{margin:0}
  input,textarea,select{background:#1c1837;color:#fff;border:1px solid #2a2650;border-radius:10px;padding:10px}
  </style>
  <div class="wrap">
    <div class="card">
      <h2>My Lists – Admin</h2>
      <div class="mini">Last sync: <span id="lastSync">${lastSyncText}</span></div>
      <div class="row" style="margin-top:10px;gap:8px">
        <button id="syncBtn">Sync IMDb Lists Now</button>
        <button id="purgeBtn" class="btn2">🧹 Purge & Sync</button>
        <span class="mini">Manifest:</span>
        <span class="code">${manifestUrl}</span>
        <a class="mini" style="margin-left:8px" href="https://web.stremio.com/#/addons/3rdparty/add?addon=${encodeURIComponent(manifestUrl)}">Install in Stremio</a>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Customize (enable/disable, order, defaults)</h3>
      <div id="prefs"></div>
    </div>
  </div>

  <script>
  const ADMIN = "${uid}";
  const API_BASE = "/api";
  const SORT_OPTIONS = ${JSON.stringify(SORT_OPTIONS)};

  function api(path, opts){ const url = API_BASE + path + (path.includes('?')?'&':'?') + 'admin=' + ADMIN; return fetch(url, opts); }

  async function getPrefs(){ const r = await api('/prefs'); return r.json(); }
  async function setPrefs(p){ const r = await api('/prefs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(p) }); return r.json(); }
  async function getLists(){ const r = await api('/lists'); return r.json(); }
  async function getListItems(lsid){ const r = await api('/list-items', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid }) }); return r.json(); }
  async function post(path, body){ const r = await api(path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) }); return r.json ? r.json() : r.text(); }

  document.getElementById('syncBtn').onclick = async ()=>{ await post('/sync'); location.reload(); };
  document.getElementById('purgeBtn').onclick = async ()=>{ await post('/purge-sync'); location.reload(); };

  // Render customize table (simplified version of your admin)
  (async function init(){
    const prefs = await getPrefs();
    const lists = await getLists();
    const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));
    const order = (prefs.order && prefs.order.length) ? prefs.order.filter(id=>lists[id]) : [];
    const missing = Object.keys(lists).filter(id=>!order.includes(id)).sort((a,b)=> (lists[a].name||a).localeCompare(lists[b].name||b));
    const ordered = order.concat(missing);

    const root = document.getElementById('prefs');
    function el(tag,attrs,children){ const x=document.createElement(tag); if(attrs) for(const k in attrs){ if(attrs[k]===null) continue; x.setAttribute(k,attrs[k]); } (children||[]).forEach(c=>x.appendChild(c)); return x; }
    function text(s){ return document.createTextNode(s); }

    const table = el('table');
    const thead = el('thead',{},[el('tr',{},[ el('th',{},[text('')]), el('th',{},[text('Enabled')]), el('th',{},[text('List (lsid)')]), el('th',{},[text('Items')]), el('th',{},[text('Default sort')]), el('th',{},[text('Open')]) ])]);
    const tbody = el('tbody');
    table.appendChild(thead); table.appendChild(tbody);

    function addRow(lsid){
      const L = lists[lsid] || {};
      const tr = el('tr');
      const drag = el('td',{},[text('⋮⋮')]);
      const cb = el('input',{type:'checkbox'}); cb.checked = enabledSet.has(lsid);
      cb.onchange = ()=>{ if(cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); };
      const name = el('td',{},[ el('div',{},[text(L.name||lsid)]), el('small',{},[text(lsid)]) ]);
      const count = el('td',{},[text(String((L.ids||[]).length))]);
      const sel = el('select'); SORT_OPTIONS.forEach(o=>{ const opt=el('option',{value:o}); opt.textContent=o; if(((prefs.perListSort||{})[lsid]||'name_asc')===o) opt.selected=true; sel.appendChild(opt); });
      sel.onchange = ()=>{ prefs.perListSort = prefs.perListSort || {}; prefs.perListSort[lsid] = sel.value; };
      const open = el('button'); open.textContent = 'Manage'; open.onclick = async ()=>{
        const data = await getListItems(lsid);
        const wrap = document.createElement('div'); wrap.style.padding='8px';
        const ul = el('ul',{class:'thumbs'});
        for(const it of data.items){
          const li = el('li',{class:'thumb'});
          const img = el('img'); img.src = it.poster || ''; li.appendChild(img);
          li.appendChild(el('div',{},[ el('div',{},[text(it.name||it.id)]), el('small',{},[text(it.id)]) ]));
          ul.appendChild(li);
        }
        wrap.appendChild(ul);
        const dlg = document.createElement('dialog'); dlg.style.width='720px'; dlg.appendChild(wrap); document.body.appendChild(dlg); dlg.showModal(); dlg.onclick = ()=>{ dlg.close(); dlg.remove(); };
      };
      const tdEnabled = el('td',{},[cb]);
      const tdSort = el('td',{},[sel]);
      const tdOpen = el('td',{},[open]);
      tr.appendChild(drag); tr.appendChild(tdEnabled); tr.appendChild(name); tr.appendChild(count); tr.appendChild(tdSort); tr.appendChild(tdOpen);
      tbody.appendChild(tr);
    }
    ordered.forEach(addRow);

    const save = el('button'); save.textContent='Save'; save.onclick = async ()=>{
      const rows = Array.from(tbody.querySelectorAll('tr'));
      prefs.enabled = Array.from(enabledSet);
      prefs.order = rows.map(tr => tr.querySelector('small').textContent);
      await setPrefs(prefs);
      alert('Saved');
    };
    root.appendChild(table);
    root.appendChild(document.createElement('br'));
    root.appendChild(save);
  })();
  </script>`);
});

// ---------- Per-user Addon endpoints ----------
app.get("/u/:uid/manifest.json", async (req,res)=>{
  const uid = req.params.uid;
  await applySnapshotFor(uid);
  const version = `13.0.0-${MANIFEST_REV}`;
  res.json({
    id: `org.mylists.${uid}`,
    version,
    name: "My Lists (Personal)",
    description: "Your IMDb lists as catalogs (cached).",
    resources: ["catalog","meta"],
    types: ["my lists","movie","series"],
    idPrefixes: ["tt"],
    behaviorHints: { configurable: true, configurationPage: `${baseUrl(req)}/u/${uid}/admin?key=${uid}` },
    catalogs: catalogs()
  });
});

app.get("/u/:uid/catalog/:type/:id/:extra?.json", async (req,res)=>{
  const uid = req.params.uid;
  await applySnapshotFor(uid);
  try{
    const { id } = req.params;
    if (!id || !id.startsWith("list:")) return res.json({ metas: [] });
    const lsid = id.slice(5);
    const extra = Object.fromEntries(new URLSearchParams(req.params.extra||"").entries());
    const skip  = Math.max(0, Number(extra.skip||0));
    const limit = Math.min(Number(extra.limit||100), 200);
    const metas = listMetas(lsid, extra);
    res.json({ metas: metas.slice(skip, skip+limit) });
  }catch(e){ console.error(e); res.status(500).send("Internal Server Error"); }
});

app.get("/u/:uid/meta/:type/:id.json", async (req,res)=>{
  const uid = req.params.uid;
  await applySnapshotFor(uid);
  try{
    const imdbId = req.params.id;
    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);
    if (!rec || !rec.meta) {
      const fb = FALLBK.get(imdbId) || {};
      return res.json({ meta: { id: imdbId, type: rec?.kind || fb.type || "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
    }
    res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
  }catch(e){ console.error(e); res.status(500).send("Internal Server Error"); }
});

// ---------- Admin API (works for both global and per-user via admin=<uid>) ----------
function adminUid(req){
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return u.searchParams.get("admin") || "";
}

app.get("/api/lists", async (req,res)=>{
  const uid = adminUid(req);
  if (!uid) return res.status(403).send("Forbidden");
  await applySnapshotFor(uid);
  res.json(LISTS);
});
app.get("/api/prefs", async (req,res)=>{
  const uid = adminUid(req); if (!uid) return res.status(403).send("Forbidden");
  await applySnapshotFor(uid); res.json(PREFS);
});
app.post("/api/prefs", async (req,res)=>{
  const uid = adminUid(req); if (!uid) return res.status(403).send("Forbidden");
  await applySnapshotFor(uid);
  try{
    const body = req.body || {};
    if (!PREFS.enabled || !PREFS.order) {
      // init from lists
      const ids = Object.keys(LISTS);
      PREFS.enabled = ids.slice();
      PREFS.order   = ids.slice();
    }
    if (Array.isArray(body.enabled)) PREFS.enabled = Array.from(new Set(body.enabled.filter(isListId)));
    if (Array.isArray(body.order))   PREFS.order   = body.order.filter(isListId);
    if (body.defaultList) PREFS.defaultList = String(body.defaultList);
    if (typeof body.perListSort === "object") PREFS.perListSort = body.perListSort;
    if (typeof body.sortOptions === "object") PREFS.sortOptions = Object.fromEntries(Object.entries(body.sortOptions||{}).map(([k,v])=>[k,clampSortOptions(v)]));
    if (typeof body.customOrder === "object") PREFS.customOrder = body.customOrder;
    await persistCurrent();
    MANIFEST_REV += 1;
    res.json({ ok:true, manifestRev: MANIFEST_REV });
  }catch(e){ console.error("prefs:", e); res.status(500).send("Failed"); }
});

app.post("/api/list-items", async (req,res)=>{
  const uid = adminUid(req); if (!uid) return res.status(403).send("Forbidden");
  await applySnapshotFor(uid);
  try{
    const lsid = String(req.body.lsid||"");
    if (!isListId(lsid) || !LISTS[lsid]) return res.status(400).send("Invalid lsid");
    const list = LISTS[lsid];
    const ed = (PREFS.listEdits && PREFS.listEdits[lsid]) || { added:[], removed:[] };
    const removed = new Set((ed.removed||[]).filter(isImdb));
    const added   = (ed.added||[]).filter(isImdb);
    let ids = (list.ids||[]).filter(tt => !removed.has(tt));
    for (const tt of added) if (!ids.includes(tt)) ids.push(tt);
    const items = [];
    for (const tt of ids){ await getBestMeta(tt); CARD.set(tt, cardFor(tt)); items.push(CARD.get(tt)); }
    res.json({ items });
  }catch(e){ console.error(e); res.status(500).send("Failed"); }
});
app.post("/api/list-add", async (req,res)=>{
  const uid = adminUid(req); if (!uid) return res.status(403).send("Forbidden");
  await applySnapshotFor(uid);
  try{
    const lsid = String(req.body.lsid||""); let tt = String(req.body.id||"").trim();
    const m = tt.match(/tt\d{7,}/i);
    if (!isListId(lsid) || !m) return res.status(400).send("Bad input");
    tt = m[0];
    PREFS.listEdits = PREFS.listEdits || {};
    const ed = PREFS.listEdits[lsid] || (PREFS.listEdits[lsid] = { added:[], removed:[] });
    if (!ed.added.includes(tt)) ed.added.push(tt);
    ed.removed = (ed.removed || []).filter(x=>x!==tt);
    await getBestMeta(tt); CARD.set(tt, cardFor(tt));
    await persistCurrent(); MANIFEST_REV += 1;
    res.json({ ok:true });
  }catch(e){ console.error("list-add:", e); res.status(500).send("Failed"); }
});
app.post("/api/list-remove", async (req,res)=>{
  const uid = adminUid(req); if (!uid) return res.status(403).send("Forbidden");
  await applySnapshotFor(uid);
  try{
    const lsid = String(req.body.lsid||""); const tt = String(req.body.id||"").trim();
    if (!isListId(lsid) || !isImdb(tt)) return res.status(400).send("Bad input");
    PREFS.listEdits = PREFS.listEdits || {};
    const ed = PREFS.listEdits[lsid] || (PREFS.listEdits[lsid] = { added:[], removed:[] });
    if (!ed.removed.includes(tt)) ed.removed.push(tt);
    ed.added = (ed.added || []).filter(x=>x!==tt);
    await persistCurrent(); MANIFEST_REV += 1;
    res.json({ ok:true });
  }catch(e){ console.error("list-remove:", e); res.status(500).send("Failed"); }
});
app.post("/api/custom-order", async (req,res)=>{
  const uid = adminUid(req); if (!uid) return res.status(403).send("Forbidden");
  await applySnapshotFor(uid);
  try{
    const lsid = String(req.body.lsid||""); const order = Array.isArray(req.body.order)?req.body.order.filter(isImdb):[];
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    PREFS.customOrder = PREFS.customOrder || {}; PREFS.customOrder[lsid] = order;
    await persistCurrent(); MANIFEST_REV += 1;
    res.json({ ok:true });
  }catch(e){ console.error("custom-order:", e); res.status(500).send("Failed"); }
});
app.post("/api/list-reset", async (req,res)=>{
  const uid = adminUid(req); if (!uid) return res.status(403).send("Forbidden");
  await applySnapshotFor(uid);
  try{
    const lsid = String(req.body.lsid||""); if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    PREFS.customOrder = PREFS.customOrder || {}; delete PREFS.customOrder[lsid];
    await persistCurrent(); MANIFEST_REV += 1;
    res.json({ ok:true });
  }catch(e){ console.error("list-reset:", e); res.status(500).send("Failed"); }
});
app.post("/api/add-sources", async (req,res)=>{
  const uid = adminUid(req); if (!uid) return res.status(403).send("Forbidden");
  await applySnapshotFor(uid);
  try{
    const users = Array.isArray(req.body.users) ? req.body.users.map(s=>String(s).trim()).filter(Boolean) : [];
    const lists = Array.isArray(req.body.lists) ? req.body.lists.map(s=>String(s).trim()).filter(Boolean) : [];
    PREFS.sources = PREFS.sources || { users:[], lists:[] };
    PREFS.sources.users = Array.from(new Set([ ...(PREFS.sources.users||[]), ...users ]));
    PREFS.sources.lists = Array.from(new Set([ ...(PREFS.sources.lists||[]), ...lists ]));
    await fullSync({ rediscover:true });
    res.status(200).send("Sources added & synced");
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});
app.post("/api/sync", async (req,res)=>{
  const uid = adminUid(req); if (!uid) return res.status(403).send("Forbidden");
  await applySnapshotFor(uid);
  try{ await fullSync({ rediscover:true }); res.json({ ok:true }); }catch(e){ console.error(e); res.status(500).send("Sync failed"); }
});
app.post("/api/purge-sync", async (req,res)=>{
  const uid = adminUid(req); if (!uid) return res.status(403).send("Forbidden");
  await applySnapshotFor(uid);
  try{
    PREFS.blocked = Array.from(new Set([ ...(PREFS.blocked||[]) ]));
    await fullSync({ rediscover:true }); res.json({ ok:true });
  }catch(e){ console.error(e); res.status(500).send("Purge failed"); }
});

// ---------- Boot ----------
app.get("/health", (_req,res)=> res.type("text/plain").send("ok"));
app.listen(PORT, HOST, ()=>{
  console.log(`\nPublic generator running on http://localhost:${PORT}\n`);
});
