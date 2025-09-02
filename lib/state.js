// lib/state.js – shared state & logic
import fs from "fs/promises";

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/12.2";
export const CINEMETA = "https://v3-cinemeta.strem.io";
export const SORT_OPTIONS = ["custom","imdb","date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"];
const VALID_SORT = new Set(SORT_OPTIONS);

// env
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";
export const state = {
  IMDB_USER_URL     : process.env.IMDB_USER_URL || "",
  IMDB_SYNC_MINUTES : Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60)),
  UPGRADE_EPISODES  : String(process.env.UPGRADE_EPISODES || "true").toLowerCase() !== "false",

  IMDB_LIST_IDS: (process.env.IMDB_LIST_IDS || "").split(/[,\s]+/).map(s=>s.trim()).filter(s=>/^ls\d{6,}$/i.test(s)),

  LISTS : Object.create(null),

  PREFS: {
    enabled: [], order: [], defaultList: "",
    perListSort: {}, sortOptions: {}, customOrder: {},
    upgradeEpisodes: true, extras:{}, removed:{}, sources:{users:[],lists:[]}, blocked: []
  },

  BEST:   new Map(),
  FALLBK: new Map(),
  EP2SER: new Map(),
  CARD:   new Map(),

  LAST_SYNC_AT: 0,
  syncInProgress: false,
  syncTimer: null,
  MANIFEST_REV: 1,
  LAST_MANIFEST_KEY: "",

  SNAP_LOCAL: "data/snapshot.json"
};

const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};

export const isImdb = v => /^tt\d{7,}$/i.test(String(v||""));
export const isListId = v => /^ls\d{6,}$/i.test(String(v||""));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const minutes = ms => Math.round(ms/60000);
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

export function adminAllowed(req){
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return (u.searchParams.get("admin") || req.headers["x-admin-key"]) === ADMIN_PASSWORD;
}
export function addonAllowed(req){
  if (!SHARED_SECRET) return true;
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return u.searchParams.get("key") === SHARED_SECRET;
}

export function manifestKey() {
  const enabled = (state.PREFS.enabled && state.PREFS.enabled.length) ? state.PREFS.enabled : Object.keys(state.LISTS);
  const names = enabled.map(id => state.LISTS[id]?.name || id).sort().join("|");
  const perSort = JSON.stringify(state.PREFS.perListSort || {});
  const perOpts = JSON.stringify(state.PREFS.sortOptions || {});
  const custom = Object.keys(state.PREFS.customOrder || {}).length;
  const localA = JSON.stringify(state.PREFS.extras || {});
  const localR = JSON.stringify(state.PREFS.removed || {});
  const order = (state.PREFS.order || []).join(",");
  return `${enabled.join(",")}#${order}#${state.PREFS.defaultList}#${names}#${perSort}#${perOpts}#c${custom}#a${localA.length}#r${localR.length}`;
}

export function catalogs(){
  const ids = getEnabledOrderedIds();
  return ids.map(lsid => ({
    type: "My lists",
    id: `list:${lsid}`,
    name: `🗂 ${state.LISTS[lsid]?.name || lsid}`,
    extraSupported: ["search","skip","limit","sort"],
    extra: [
      { name:"search" }, { name:"skip" }, { name:"limit" },
      { name:"sort", options: (state.PREFS.sortOptions && state.PREFS.sortOptions[lsid] && state.PREFS.sortOptions[lsid].length) ? state.PREFS.sortOptions[lsid] : SORT_OPTIONS }
    ],
    posterShape: "poster"
  }));
}
function getEnabledOrderedIds() {
  const allIds  = Object.keys(state.LISTS);
  const enabled = new Set(state.PREFS.enabled && state.PREFS.enabled.length ? state.PREFS.enabled : allIds);
  const base    = (state.PREFS.order && state.PREFS.order.length ? state.PREFS.order.filter(id => state.LISTS[id]) : []);
  const missing = allIds.filter(id => !base.includes(id))
    .sort((a,b)=>( (state.LISTS[a]?.name||a).localeCompare(state.LISTS[b]?.name||b) ));
  const ordered = base.concat(missing);
  return ordered.filter(id => enabled.has(id));
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
function normalizeListIdOrUrl(s) {
  if (!s) return null;
  s = String(s).trim();
  const m = s.match(/ls\d{6,}/i);
  if (m) return { id: m[0], url: `https://www.imdb.com/list/${m[0]}/` };
  if (/imdb\.com\/list\//i.test(s)) return { id: null, url: s };
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

export function cardFor(imdbId) {
  const rec = state.BEST.get(imdbId) || { kind: null, meta: null };
  const m = rec.meta || {}; const fb = state.FALLBK.get(imdbId) || {};
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
export function stableSort(items, sortKey) {
  const s = String(sortKey || "name_asc").toLowerCase();
  if (s === "imdb") return items.slice();
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
export function applyCustomOrder(metas, lsid) {
  const order = (state.PREFS.customOrder && state.PREFS.customOrder[lsid]) || [];
  if (!order || !order.length) return metas.slice();
  const pos = new Map(order.map((id, i) => [id, i]));
  return metas.slice().sort((a,b) => {
    const pa = pos.has(a.id) ? pos.get(a.id) : Number.MAX_SAFE_INTEGER;
    const pb = pos.has(b.id) ? pos.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return (a.name||"").localeCompare(b.name||"");
  });
}

export function getListItemsFor(lsid){
  const list = state.LISTS[lsid];
  if (!list) return [];
  return (list.ids || []);
}

// IMDb/meta bootstrap
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
  if (state.EP2SER.has(imdbId)) return state.EP2SER.get(imdbId);
  const ld = await imdbJsonLd(imdbId);
  let seriesId = null;
  try {
    const node = Array.isArray(ld && ld["@graph"]) ? ld["@graph"].find(x => /TVEpisode/i.test(x["@type"])) : ld;
    const part = node && (node.partOfSeries || node.partOfTVSeries || (node.partOfSeason && node.partOfSeason.partOfSeries));
    const url = typeof part === "string" ? part : (part && (part.url || part.sameAs || part["@id"]));
    if (url) { const m = String(url).match(/tt\d{7,}/i); if (m) seriesId = m[0]; }
  } catch {}
  if (seriesId) state.EP2SER.set(imdbId, seriesId);
  return seriesId;
}
async function fetchCinemeta(kind, imdbId) {
  try {
    const r = await fetch(`${CINEMETA}/meta/${kind}/${imdbId}.json`, { headers: { "User-Agent": UA, "Accept":"application/json" } });
    const j = await r.json().catch(()=>null);
    return j && j.meta ? j.meta : null;
  } catch { return null; }
}
export async function getBestMeta(imdbId) {
  if (state.BEST.has(imdbId)) return state.BEST.get(imdbId);
  let meta = await fetchCinemeta("series", imdbId);
  if (meta) { const rec = { kind: "series", meta }; state.BEST.set(imdbId, rec); return rec; }
  meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind: "movie", meta }; state.BEST.set(imdbId, rec); return rec; }
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
  state.BEST.set(imdbId, rec);
  if (name || poster) state.FALLBK.set(imdbId, { name, poster, releaseDate: released, year, type: rec.kind });
  return rec;
}

export function maybeBackgroundSync() {
  if (state.IMDB_SYNC_MINUTES <= 0) return;
  const stale = Date.now() - state.LAST_SYNC_AT > state.IMDB_SYNC_MINUTES*60*1000;
  if (stale && !state.syncInProgress) fullSync({ rediscover:true }).then(scheduleNextSync);
}
export function scheduleNextSync() {
  if (state.syncTimer) clearTimeout(state.syncTimer);
  if (state.IMDB_SYNC_MINUTES <= 0) return;
  state.syncTimer = setTimeout(() => fullSync({ rediscover:true }).then(scheduleNextSync), state.IMDB_SYNC_MINUTES*60*1000);
}

export async function harvestSources() {
  const discovered = [];
  if (state.IMDB_USER_URL) {
    try { discovered.push(...await discoverFromUserLists(state.IMDB_USER_URL)); } catch(e){ console.warn("[DISCOVER] main failed:", e.message); }
  }
  const users = Array.from(new Set((state.PREFS.sources?.users || []).map(s => String(s).trim()).filter(Boolean)));
  for (const u of users) {
    try { discovered.push(...await discoverFromUserLists(u)); }
    catch(e){ console.warn("[DISCOVER] user", u, "failed:", e.message); }
    await sleep(80);
  }
  const addlRaw = (state.PREFS.sources?.lists || []).concat(state.IMDB_LIST_IDS || []);
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
  const blocked = new Set(state.PREFS.blocked || []);
  const map = new Map();
  for (const d of discovered) if (!blocked.has(d.id)) map.set(d.id, d);
  return Array.from(map.values());
}

export async function fullSync({ rediscover = true } = {}) {
  if (state.syncInProgress) return;
  state.syncInProgress = true;
  const started = Date.now();
  try {
    let discovered = [];
    if (rediscover) discovered = await harvestSources();

    if ((!discovered || !discovered.length) && state.IMDB_LIST_IDS.length) {
      discovered = state.IMDB_LIST_IDS.map(id => ({ id, name: id, url: `https://www.imdb.com/list/${id}/` }));
      console.log(`[DISCOVER] used IMDB_LIST_IDS fallback (${discovered.length})`);
    }

    const next = Object.create(null);
    const seen = new Set();
    for (const d of discovered) { next[d.id] = { id: d.id, name: d.name || d.id, url: d.url, ids: [] }; seen.add(d.id); }
    const blocked = new Set(state.PREFS.blocked || []);
    for (const id of Object.keys(state.LISTS)) if (!seen.has(id) && !blocked.has(id)) next[id] = state.LISTS[id];

    const uniques = new Set();
    for (const id of Object.keys(next)) {
      const url = next[id].url || `https://www.imdb.com/list/${id}/`;
      let ids = [];
      try { ids = await fetchImdbListIdsAllPages(url); } catch {}
      const rem = new Set((state.PREFS.removed && state.PREFS.removed[id]) || []);
      const ex  = ((state.PREFS.extras && state.PREFS.extras[id]) || []).filter(isImdb);
      ids = ids.filter(tt => !rem.has(tt));
      for (const tt of ex) if (!ids.includes(tt)) ids.push(tt);

      next[id].ids = ids;
      ids.forEach(tt => uniques.add(tt));
      await sleep(60);
    }

    for (const tt of Array.from(uniques)) {
      await getBestMeta(tt);
      state.CARD.set(tt, cardFor(tt));
    }

    state.LISTS = next;
    state.LAST_SYNC_AT = Date.now();

    const allIds   = Object.keys(state.LISTS);
    const keep     = Array.isArray(state.PREFS.order) ? state.PREFS.order.filter(id => state.LISTS[id]) : [];
    const missingO = allIds.filter(id => !keep.includes(id));
    state.PREFS.order = keep.concat(missingO);

    if (Array.isArray(state.PREFS.enabled) && state.PREFS.enabled.length) {
      state.PREFS.enabled = state.PREFS.enabled.filter(id => state.LISTS[id]);
    }

    const valid = new Set(Object.keys(state.LISTS));
    if (state.PREFS.customOrder) {
      for (const k of Object.keys(state.PREFS.customOrder)) if (!valid.has(k)) delete state.PREFS.customOrder[k];
    }

    const key = manifestKey();
    if (key !== state.LAST_MANIFEST_KEY) {
      state.LAST_MANIFEST_KEY = key;
      state.MANIFEST_REV++;
      console.log(`[SYNC] catalogs changed → manifest rev ${state.MANIFEST_REV}`);
    }

    await saveSnapshot();
    console.log(`[SYNC] ok – ${Array.from(uniques).length} ids across ${Object.keys(state.LISTS).length} lists in ${minutes(Date.now()-started)} min`);
  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    state.syncInProgress = false;
  }
}

export async function saveSnapshot() {
  try {
    await fs.mkdir("data", { recursive: true });
    await fs.writeFile(state.SNAP_LOCAL, JSON.stringify({
      lastSyncAt: state.LAST_SYNC_AT,
      manifestRev: state.MANIFEST_REV,
      lists: state.LISTS,
      prefs: state.PREFS,
      fallback: Object.fromEntries(state.FALLBK),
      cards: Object.fromEntries(state.CARD),
      ep2ser: Object.fromEntries(state.EP2SER)
    }, null, 2), "utf8");
  } catch(e){ console.warn("[SNAPSHOT] save failed:", e.message); }
}
export async function loadSnapshot() {
  try {
    const txt = await fs.readFile(state.SNAP_LOCAL, "utf8");
    const snap = JSON.parse(txt);
    state.LISTS = snap.lists || state.LISTS;
    state.PREFS = { ...state.PREFS, ...(snap.prefs || {}) };
    state.FALLBK.clear(); if (snap.fallback) for (const [k,v] of Object.entries(snap.fallback)) state.FALLBK.set(k, v);
    state.CARD.clear();   if (snap.cards)    for (const [k,v] of Object.entries(snap.cards))    state.CARD.set(k, v);
    state.EP2SER.clear(); if (snap.ep2ser)   for (const [k,v] of Object.entries(snap.ep2ser))   state.EP2SER.set(k, v);
    state.MANIFEST_REV = snap.manifestRev || state.MANIFEST_REV;
    state.LAST_SYNC_AT = snap.lastSyncAt || 0;
    state.LAST_MANIFEST_KEY = manifestKey();
    console.log("[BOOT] snapshot loaded");
  } catch(e){ /* ignore */ }
}
