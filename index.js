/*  My Lists – IMDb → Stremio (multi-user, custom per-list ordering)
 *  v12.1.0
 */

"use strict";
const express = require("express");
const fs = require("fs/promises");
const path = require("path");

/* ---------------- ENV ---------------- */
const PORT  = Number(process.env.PORT || 10000);
const HOST  = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

// Optional global auto-sync minutes (per user)
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

// Optional GitHub persistence
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || "";
const GITHUB_OWNER  = process.env.GITHUB_OWNER  || "";
const GITHUB_REPO   = process.env.GITHUB_REPO   || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GH_ENABLED    = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

// (Legacy single-user envs still work if you don’t create UIDs via the landing page)
const LEGACY_IMDB_USER_URL = process.env.IMDB_USER_URL || "";
const LEGACY_UPGRADE_EPISODES = String(process.env.UPGRADE_EPISODES || "true").toLowerCase() !== "false";

// UA / headers
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/12.1";
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};
const CINEMETA = "https://v3-cinemeta.strem.io";

/* --------------- GLOBAL STATE --------------- */
// Global metadata caches (shared across users)
const BEST   = new Map(); // Map<tt, { kind, meta }>
const FALLBK = new Map(); // Map<tt, { name?, poster?, releaseDate?, year?, type? }>
const EP2SER = new Map(); // Map<episode_tt, parent_series_tt>
const CARD   = new Map(); // Map<tt, card>

// Per-user state in memory
// USERS.get(uid) -> { uid, imdbUrl, lists, prefs, manifestRev, lastSyncAt, timers:{sync?:Timeout}, syncing:boolean }
const USERS = new Map();

/* --------------- UTILS --------------- */
const isImdb = v => /^tt\d{7,}$/i.test(String(v||""));
const isListId = v => /^ls\d{6,}$/i.test(String(v||""));
const minutes = ms => Math.round(ms/60000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64 = s => Buffer.from(s, "utf8").toString("base64");
const fromB64 = s => Buffer.from(s || "", "base64").toString("utf8");

function uid() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 4);
}
function defaultPrefs() {
  return {
    enabled: [],
    order: [],
    defaultList: "",
    perListSort: {},         // { lsid: 'custom' | 'date_asc' | ... }
    customOrder: {},         // { lsid: [ 'tt...', ... ] }
    upgradeEpisodes: true
  };
}

/* --------------- FETCH HELPERS --------------- */
async function fetchText(url) {
  const r = await fetch(url, { headers: REQ_HEADERS, redirect: "follow" });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" }, redirect: "follow" });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}
const withParam = (u,k,v) => { const x = new URL(u); x.searchParams.set(k,v); return x.toString(); };

/* --------------- GITHUB PERSISTENCE --------------- */
async function gh(method, relPath, bodyObj) {
  const api = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${relPath}`;
  const r = await fetch(api, {
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
    throw new Error(`GitHub ${method} ${relPath} -> ${r.status}: ${t}`);
  }
  return r.json();
}
async function ghGetSha(relPath) {
  try {
    const j = await gh("GET", `/contents/${encodeURIComponent(relPath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    return j && j.sha || null;
  } catch { return null; }
}
async function saveUser(user) {
  // local
  try {
    await fs.mkdir(path.join("data","users"), { recursive: true });
    await fs.writeFile(path.join("data","users", `${user.uid}.json`), JSON.stringify(user, null, 2), "utf8");
  } catch {/* ignore */}
  // GitHub
  if (!GH_ENABLED) return;
  const rel = `users/${user.uid}.json`;
  const content = b64(JSON.stringify(user, null, 2));
  const sha = await ghGetSha(rel);
  const body = { message: `Update ${rel}`, content, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  await gh("PUT", `/contents/${encodeURIComponent(rel)}`, body);
}
async function loadUser(uidStr) {
  // GitHub first
  if (GH_ENABLED) {
    try {
      const j = await gh("GET", `/contents/${encodeURIComponent(`users/${uidStr}.json`)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
      return JSON.parse(fromB64(j.content));
    } catch {/* ignore */}
  }
  // Local
  try {
    const txt = await fs.readFile(path.join("data","users", `${uidStr}.json`), "utf8");
    return JSON.parse(txt);
  } catch { return null; }
}

/* --------------- IMDb SCRAPE --------------- */
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(withParam(userListsUrl, "_", Date.now()));
  const ids = new Set(); let m;

  // Robust parsing
  let re = /href=['"](?:https?:\/\/(?:www\.)?imdb\.com)?\/list\/(ls\d{6,})\/['"]/gi;
  while ((m = re.exec(html))) ids.add(m[1]);
  if (!ids.size) {
    re = /\/list\/(ls\d{6,})\//gi;
    while ((m = re.exec(html))) ids.add(m[1]);
  }
  const arr = Array.from(ids).map(id => ({ id, url: `https://www.imdb.com/list/${id}/` }));

  // Try to resolve names quickly
  await Promise.all(arr.map(async L => {
    try {
      const h = await fetchText(withParam(L.url, "_", Date.now()));
      const t1 = h.match(/<h1[^>]+data-testid=["']list-header-title["'][^>]*>(.*?)<\/h1>/i);
      const t2 = h.match(/<h1[^>]*class=["'][^"']*header[^"']*["'][^>]*>(.*?)<\/h1>/i);
      const title = (t1 ? t1[1] : (t2 ? t2[1] : "")).replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
      L.name = title || L.id;
    } catch { L.name = L.id; }
  }));

  return arr;
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

/* --------------- METADATA --------------- */
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
  // series first, then movie
  let meta = await fetchCinemeta("series", imdbId);
  if (meta) { const rec = { kind:"series", meta }; BEST.set(imdbId, rec); return rec; }
  meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind:"movie", meta }; BEST.set(imdbId, rec); return rec; }

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
  const rec = BEST.get(imdbId) || { kind:null, meta:null };
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
function applyCustomOrder(metas, orderArr) {
  if (!orderArr || !orderArr.length) return metas.slice();
  const pos = new Map(orderArr.map((id,i)=>[id,i]));
  return metas.slice().sort((a,b) => {
    const pa = pos.has(a.id) ? pos.get(a.id) : 1e9;
    const pb = pos.has(b.id) ? pos.get(b.id) : 1e9;
    if (pa !== pb) return pa - pb;
    return (a.name||"").localeCompare(b.name||"");
  });
}

/* --------------- PER-USER SYNC --------------- */
function manifestKey(user) {
  const enabled = (user.prefs.enabled && user.prefs.enabled.length) ? user.prefs.enabled : Object.keys(user.lists || {});
  const names = enabled.map(id => user.lists[id]?.name || id).sort().join("|");
  const perSort = JSON.stringify(user.prefs.perListSort || {});
  const custom = Object.keys(user.prefs.customOrder || {}).length;
  return `${enabled.join(",")}#${(user.prefs.order||[]).join(",")}#${user.prefs.defaultList}#${names}#${perSort}#c${custom}`;
}
async function fullSync(user, { rediscover = true } = {}) {
  if (user.syncing) return;
  user.syncing = true;
  const started = Date.now();
  try {
    let discovered = [];
    if (user.imdbUrl && rediscover) {
      try { discovered = await discoverListsFromUser(user.imdbUrl); }
      catch(e){ console.warn(`[${user.uid}] DISCOVER failed:`, e.message); }
    }

    const next = Object.create(null);
    const seen = new Set();
    for (const d of discovered) { next[d.id] = { id:d.id, name:d.name||d.id, url:d.url, ids:[] }; seen.add(d.id); }
    // keep any existing lists not present in discovery (e.g., manually added)
    for (const id of Object.keys(user.lists || {})) if (!seen.has(id)) next[id] = user.lists[id];

    // pull each list
    const allIds = new Set();
    for (const id of Object.keys(next)) {
      const url = next[id].url || `https://www.imdb.com/list/${id}/`;
      let ids = [];
      try { ids = await fetchImdbListIdsAllPages(url); } catch {}
      next[id].ids = ids;
      ids.forEach(tt => allIds.add(tt));
      await sleep(60);
    }

    // upgrade episodes (per-user preference)
    let idsToPreload = Array.from(allIds);
    if (user.prefs.upgradeEpisodes) {
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

    // preload cards into global cache
    for (const tt of idsToPreload) { await getBestMeta(tt); CARD.set(tt, cardFor(tt)); }

    user.lists = next;
    user.lastSyncAt = Date.now();

    // bump manifest rev if catalogs content changed
    const key = manifestKey(user);
    if (key !== user._lastManifestKey) {
      user._lastManifestKey = key;
      user.manifestRev = (user.manifestRev || 1) + 1;
      console.log(`[${user.uid}] SYNC catalogs changed → rev ${user.manifestRev}`);
    }

    await saveUser(user);

    console.log(`[${user.uid}] SYNC ok – ${idsToPreload.length} ids across ${Object.keys(user.lists).length} lists in ${minutes(Date.now()-started)} min`);
  } catch (e) {
    console.error(`[${user.uid}] SYNC failed:`, e);
  } finally {
    user.syncing = false;
  }
}
function scheduleNextSync(user) {
  if (user.timers && user.timers.sync) clearTimeout(user.timers.sync);
  if (IMDB_SYNC_MINUTES <= 0) return;
  user.timers = user.timers || {};
  user.timers.sync = setTimeout(() => fullSync(user, { rediscover:true }).then(()=>scheduleNextSync(user)), IMDB_SYNC_MINUTES*60*1000);
}
function maybeBackgroundSync(user) {
  if (IMDB_SYNC_MINUTES <= 0) return;
  const stale = !user.lastSyncAt || (Date.now() - user.lastSyncAt > IMDB_SYNC_MINUTES*60*1000);
  if (stale && !user.syncing) fullSync(user, { rediscover:true }).then(()=>scheduleNextSync(user));
}

/* --------------- SERVER --------------- */
const app = express();
app.use((_,res,next)=>{ res.setHeader("Access-Control-Allow-Origin","*"); next(); });
app.use(express.json({ limit:"2mb" }));

/* --- allow checks --- */
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

/* -------- Landing: create a UID -------- */
app.get("/", async (req,res)=>{
  const base = absoluteBase(req);
  res.type("html").send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Create</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:760px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
input,button{font-size:16px}
input[type=text]{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px}
button{padding:10px 16px;border:0;border-radius:8px;background:#6c5ce7;color:#fff;cursor:pointer}
small{color:#666}
</style></head><body>
<h1>My Lists – IMDb ➜ Stremio</h1>
<div class="card">
  <p>Paste your IMDb <b>user lists URL</b> (e.g. <code>https://www.imdb.com/user/ur12345678/lists/</code>)</p>
  <form method="POST" action="/create">
    <input type="text" name="u" placeholder="https://www.imdb.com/user/urXXXXXXX/lists/" required />
    <div style="margin-top:12px"><button>Create my admin page</button></div>
  </form>
  <p><small>Already have a UID? Go to <code>${base}/u/&lt;your-uid&gt;/admin?admin=YOUR_PASSWORD</code></small></p>
</div>
</body></html>`);
});
app.post("/create", express.urlencoded({extended:false}), async (req,res)=>{
  try {
    const imdbUrl = String(req.body.u || "").trim();
    if (!/^https?:\/\/(www\.)?imdb\.com\/user\/ur\d+\/lists\/?/i.test(imdbUrl)) {
      return res.status(400).send("Invalid IMDb user lists URL.");
    }
    const id = uid();
    const user = {
      uid: id,
      imdbUrl,
      lists: {},
      prefs: { ...defaultPrefs(), upgradeEpisodes: true },
      manifestRev: 1,
      lastSyncAt: 0,
      _lastManifestKey: ""
    };
    USERS.set(id, user);
    await saveUser(user);
    // Start first sync in background and redirect to admin right away
    fullSync(user, { rediscover:true }).then(()=>scheduleNextSync(user));
    return res.redirect(303, `/u/${id}/admin?admin=${encodeURIComponent(ADMIN_PASSWORD)}`);
  } catch (e) {
    console.error("CREATE failed:", e);
    res.status(500).send("Failed to create user.");
  }
});

/* ----- helpers to ensure user loaded ----- */
async function ensureUser(uidStr) {
  let u = USERS.get(uidStr);
  if (!u) {
    u = await loadUser(uidStr);
    if (!u) return null;
    USERS.set(uidStr, u);
  }
  return u;
}

/* -------- Manifest & Catalogs per-user -------- */
const baseManifest = {
  id: "org.mylists.snapshot",
  version: "12.1.0",
  name: "My Lists",
  description: "Your IMDb lists as catalogs (cached).",
  resources: ["catalog","meta"],
  types: ["my lists","movie","series"],
  idPrefixes: ["tt"]
};
function catalogsForUser(user){
  const ids = Object.keys(user.lists || {}).sort((a,b)=>{
    const na=user.lists[a]?.name||a, nb=user.lists[b]?.name||b;
    return na.localeCompare(nb);
  });
  return ids.map(lsid => ({
    type: "My lists",
    id: `list:${lsid}`,
    name: `🗂 ${user.lists[lsid]?.name || lsid}`,
    extraSupported: ["search","skip","limit","sort"],
    extra: [
      { name:"search" }, { name:"skip" }, { name:"limit" },
      { name:"sort", options:["custom","date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"] }
    ],
    posterShape: "poster"
  }));
}
app.get("/u/:uid/manifest.json", async (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    const u = await ensureUser(req.params.uid);
    if (!u) return res.status(404).send("Unknown user");
    maybeBackgroundSync(u);
    const version = `${baseManifest.version}-${u.manifestRev || 1}`;
    return res.json({ ...baseManifest, version, catalogs: catalogsForUser(u) });
  } catch (e) { console.error("manifest:", e); res.status(500).send("Internal Server Error");}
});

function parseExtra(extraStr, qObj){
  const p = new URLSearchParams(extraStr||"");
  return { ...Object.fromEntries(p.entries()), ...(qObj||{}) };
}
app.get("/u/:uid/catalog/:type/:id/:extra?.json", async (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    const user = await ensureUser(req.params.uid);
    if (!user) return res.json({ metas: [] });
    maybeBackgroundSync(user);

    const id = req.params.id || "";
    if (!id.startsWith("list:")) return res.json({ metas: [] });
    const lsid = id.slice(5);
    const list = user.lists[lsid];
    if (!list) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q = String(extra.search||"").toLowerCase().trim();
    const sortReq = String(extra.sort||"").toLowerCase();
    const defaultSort = (user.prefs.perListSort && user.prefs.perListSort[lsid]) || "name_asc";
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
    if (sort === "custom") {
      const order = user.prefs.customOrder && user.prefs.customOrder[lsid];
      metas = applyCustomOrder(metas, order);
    } else {
      metas = stableSort(metas, sort);
    }
    res.json({ metas: metas.slice(skip, skip+limit) });
  } catch (e) { console.error("catalog:", e); res.status(500).send("Internal Server Error"); }
});

app.get("/u/:uid/meta/:type/:id.json", async (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    const imdbId = req.params.id;
    if (!isImdb(imdbId)) return res.json({ meta:{ id: imdbId, type:"movie", name:"Unknown item" } });
    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);
    if (!rec || !rec.meta) {
      const fb = FALLBK.get(imdbId) || {};
      return res.json({ meta: { id: imdbId, type: rec?.kind || fb.type || "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
    }
    res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
  } catch (e) { console.error("meta:", e); res.status(500).send("Internal Server Error"); }
});

/* -------- Admin APIs -------- */
app.get("/u/:uid/api/lists", async (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  const user = await ensureUser(req.params.uid);
  if (!user) return res.status(404).send("Unknown user");
  res.json(user.lists || {});
});
app.get("/u/:uid/api/prefs", async (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  const user = await ensureUser(req.params.uid);
  if (!user) return res.status(404).send("Unknown user");
  res.json(user.prefs || defaultPrefs());
});
app.post("/u/:uid/api/prefs", async (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const user = await ensureUser(req.params.uid);
    if (!user) return res.status(404).send("Unknown user");
    const body = req.body || {};
    const p = user.prefs || defaultPrefs();

    p.enabled         = Array.isArray(body.enabled) ? body.enabled.filter(isListId) : [];
    p.order           = Array.isArray(body.order)   ? body.order.filter(isListId)   : [];
    p.defaultList     = isListId(body.defaultList) ? body.defaultList : "";
    p.perListSort     = body.perListSort && typeof body.perListSort === "object" ? body.perListSort : (p.perListSort || {});
    p.upgradeEpisodes = !!body.upgradeEpisodes;

    user.prefs = p;

    // bump manifest when prefs affect catalogs
    const key = manifestKey(user);
    if (key !== user._lastManifestKey) { user._lastManifestKey = key; user.manifestRev = (user.manifestRev||1)+1; }

    await saveUser(user);
    res.status(200).send("Saved. Manifest rev " + user.manifestRev);
  }catch(e){ console.error("prefs save:", e); res.status(500).send("Failed to save"); }
});
app.get("/u/:uid/api/list-items", async (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  const user = await ensureUser(req.params.uid);
  if (!user) return res.status(404).send("Unknown user");
  const lsid = String(req.query.lsid || "");
  const list = user.lists && user.lists[lsid];
  if (!list) return res.json({ items: [] });
  const items = (list.ids||[]).map(tt => CARD.get(tt) || cardFor(tt));
  res.json({ items });
});
app.post("/u/:uid/api/custom-order", async (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const user = await ensureUser(req.params.uid);
    if (!user) return res.status(404).send("Unknown user");
    const lsid = String(req.body.lsid || "");
    const order = Array.isArray(req.body.order) ? req.body.order.filter(isImdb) : [];
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    const list = user.lists && user.lists[lsid];
    if (!list) return res.status(404).send("List not found");

    const set = new Set(list.ids);
    const clean = order.filter(id => set.has(id));

    user.prefs.customOrder = user.prefs.customOrder || {};
    user.prefs.customOrder[lsid] = clean;
    user.prefs.perListSort = user.prefs.perListSort || {};
    user.prefs.perListSort[lsid] = "custom";

    const key = manifestKey(user);
    if (key !== user._lastManifestKey) { user._lastManifestKey = key; user.manifestRev = (user.manifestRev||1)+1; }

    await saveUser(user);
    res.status(200).json({ ok:true, manifestRev: user.manifestRev });
  }catch(e){ console.error("custom-order:", e); res.status(500).send("Failed"); }
});
// Add list manually by URL or lsXXXX
app.post("/u/:uid/api/add-list", express.urlencoded({extended:false}), async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  const user = await ensureUser(req.params.uid);
  if (!user) return res.status(404).send("Unknown user");
  let inp = String(req.body.l || "").trim();

  // Accept raw lsid, or full URL to a list
  let lsid = "";
  if (isListId(inp)) lsid = inp;
  else {
    const m = inp.match(/\/list\/(ls\d{6,})/i);
    if (m) lsid = m[1];
  }
  if (!lsid) return res.redirect(303, `/u/${user.uid}/admin?admin=${encodeURIComponent(ADMIN_PASSWORD)}#add_error`);

  const url = `https://www.imdb.com/list/${lsid}/`;
  const name = lsid;
  user.lists = user.lists || {};
  if (!user.lists[lsid]) user.lists[lsid] = { id: lsid, name, url, ids: [] };

  await saveUser(user);
  // run a quick sync (just this list)
  try {
    const ids = await fetchImdbListIdsAllPages(url);
    user.lists[lsid].ids = ids;
    for (const tt of ids) { await getBestMeta(tt); CARD.set(tt, cardFor(tt)); }
    user.lastSyncAt = Date.now();
    const key = manifestKey(user);
    if (key !== user._lastManifestKey) { user._lastManifestKey = key; user.manifestRev = (user.manifestRev||1)+1; }
    await saveUser(user);
  } catch(e) { console.warn("add-list sync fail", e.message); }
  return res.redirect(303, `/u/${user.uid}/admin?admin=${encodeURIComponent(ADMIN_PASSWORD)}#added`);
});

/* ---- Sync & Purge+Sync with AUTO-REDIRECT ---- */
app.post("/u/:uid/api/sync", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const user = await ensureUser(req.params.uid);
    if (!user) return res.status(404).send("Unknown user");
    await fullSync(user, { rediscover:true });
    scheduleNextSync(user);
    // Auto-redirect back to Admin (fallback text includes Back link)
    const back = `/u/${user.uid}/admin?admin=${encodeURIComponent(ADMIN_PASSWORD)}#synced`;
    res.redirect(303, back);
  }catch(e){ console.error(e); res.status(500).send(String(e) + ` <br><a href="/u/${req.params.uid}/admin?admin=${ADMIN_PASSWORD}">Back</a>`); }
});
app.post("/u/:uid/api/purge-sync", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const user = await ensureUser(req.params.uid);
    if (!user) return res.status(404).send("Unknown user");
    user.lists = {};
    user.prefs.customOrder = user.prefs.customOrder || {};
    await fullSync(user, { rediscover:true });
    scheduleNextSync(user);
    const back = `/u/${user.uid}/admin?admin=${encodeURIComponent(ADMIN_PASSWORD)}#purged`;
    res.redirect(303, back);
  }catch(e){ console.error(e); res.status(500).send(String(e) + ` <br><a href="/u/${req.params.uid}/admin?admin=${ADMIN_PASSWORD}">Back</a>`); }
});

/* ---- Tiny debug ---- */
app.get("/u/:uid/api/debug-imdb", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const user = await ensureUser(req.params.uid);
    if (!user) return res.status(404).send("Unknown user");
    const html = await fetchText(withParam(user.imdbUrl,"_","dbg"));
    res.type("text").send(html.slice(0,2000));
  }catch(e){ res.type("text").status(500).send("Fetch failed: "+e.message); }
});

/* -------- Admin page (per user) -------- */
app.get("/u/:uid/admin", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  const user = await ensureUser(req.params.uid);
  if (!user) return res.status(404).send("Unknown user");
  const base = absoluteBase(req);
  const manifestUrl = `${base}/u/${user.uid}/manifest.json${SHARED_SECRET?`?key=${encodeURIComponent(SHARED_SECRET)}`:""}`;
  const installHref = `stremio://addon-install?url=${encodeURIComponent(manifestUrl)}`;

  // discovered preview
  let discovered = [];
  try { if (user.imdbUrl) discovered = await discoverListsFromUser(user.imdbUrl); } catch {}

  const rows = Object.keys(user.lists||{}).map(id=>{
    const L = user.lists[id]; const count=(L.ids||[]).length;
    return `<li><b>${L.name||id}</b> <small>(${count} items)</small><br/><small>${L.url||""}</small></li>`;
  }).join("") || "<li>(none)</li>";

  const disc = discovered.map(d=>`<li><b>${d.name||d.id}</b><br/><small>${d.url}</small></li>`).join("") || "<li>(none found or IMDb unreachable right now).</li>";

  const lastSyncText = user.lastSyncAt
    ? (new Date(user.lastSyncAt).toLocaleString() + " (" + minutes(Date.now()-user.lastSyncAt) + " min ago)")
    : "never";

  res.type("html").send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Admin (${user.uid})</title>
<style>
  :root{color-scheme:light}
  body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:1100px}
  .card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0;background:#fff}
  button{padding:10px 16px;border:0;border-radius:8px;background:#2d6cdf;color:#fff;cursor:pointer}
  .btn2{background:#6c5ce7}
  .btn-outline{background:#fff;color:#2d6cdf;border:1px solid #2d6cdf}
  small{color:#666}
  .code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}
  table{width:100%;border-collapse:collapse}
  th,td{padding:8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
  .muted{color:#888}
  .chev{cursor:pointer;font-size:18px;line-height:1;user-select:none}
  .drawer{background:#fafafa}
  .thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin:10px 0;padding:0;list-style:none}
  .thumb{display:flex;gap:10px;align-items:center;border:1px solid #e6e6e6;background:#fff;border-radius:10px;padding:6px 8px}
  .thumb img{width:52px;height:78px;object-fit:cover;border-radius:6px;background:#eee}
  .thumb .title{font-size:14px}
  .thumb .id{font-size:11px;color:#888}
  .thumb[draggable="true"]{cursor:grab}
  .thumb.dragging{opacity:.5}
  .rowtools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .inline-note{font-size:12px;color:#666;margin-left:8px}
</style>
</head><body>
<h1>My Lists – Admin <small>(${user.uid})</small></h1>

<div class="card">
  <h3>Current Snapshot</h3>
  <ul>${rows}</ul>
  <p><small>Last sync: ${lastSyncText}. Auto-sync every <b>${IMDB_SYNC_MINUTES}</b> min.</small></p>
  <div class="rowtools">
    <form method="POST" action="/u/${user.uid}/api/sync?admin=${encodeURIComponent(ADMIN_PASSWORD)}"><button class="btn2">Sync IMDb Lists Now</button></form>
    <form method="POST" action="/u/${user.uid}/api/purge-sync?admin=${encodeURIComponent(ADMIN_PASSWORD)}" onsubmit="return confirm('Purge caches & re-sync?')"><button>🧹 Purge & Sync</button></form>
    <a href="${installHref}" class="btn-outline" style="text-decoration:none;padding:10px 16px;border-radius:8px">Install in Stremio</a>
    <span class="inline-note">Manifest: <span class="code">${manifestUrl}</span></span>
  </div>
</div>

<div class="card">
  <h3>Customize (enable/disable, order, defaults)</h3>
  <p class="muted">Drag rows to change order. Click ▾ to open a list and drag posters to set a <b>custom</b> order (saved per list).</p>
  <div class="rowtools" style="margin:8px 0">
    <form method="POST" action="/u/${user.uid}/api/add-list?admin=${encodeURIComponent(ADMIN_PASSWORD)}">
      <input type="text" name="l" placeholder="Add list by URL or lsXXXX (0)" style="padding:8px;border:1px solid #ccc;border-radius:8px;min-width:300px" />
      <button class="btn-outline" style="margin-left:8px">Add list</button>
    </form>
    <small class="muted">You can merge lists from any IMDb user.</small>
  </div>
  <div id="prefs"></div>
</div>

<div class="card">
  <h3>Discovered at <span class="code">${user.imdbUrl || "(missing IMDb URL)"}</span></h3>
  <ul>${disc}</ul>
  <p><small>Debug: <a href="/u/${user.uid}/api/debug-imdb?admin=${encodeURIComponent(ADMIN_PASSWORD)}">open</a> (first part of HTML we receive)</small></p>
</div>

<script>
const ADMIN="${ADMIN_PASSWORD}";
const UID="${user.uid}";

async function getPrefs(){ const r = await fetch('/u/'+UID+'/api/prefs?admin='+ADMIN); return r.json(); }
async function getLists(){ const r = await fetch('/u/'+UID+'/api/lists?admin='+ADMIN); return r.json(); }
async function getListItems(lsid){ const r = await fetch('/u/'+UID+'/api/list-items?admin='+ADMIN+'&lsid='+encodeURIComponent(lsid)); return r.json(); }
async function saveCustomOrder(lsid, order){
  const r = await fetch('/u/'+UID+'/api/custom-order?admin='+ADMIN, {method:'POST',headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid, order })});
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
  return t === "input" || t === "select" || t === "button" || t === "a" || t === "label";
}

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

  const container = document.getElementById('prefs'); container.innerHTML = "";

  const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));
  const order = (prefs.order && prefs.order.length ? prefs.order.filter(id => lists[id]) : Object.keys(lists));

  const table = el('table');
  const thead = el('thead', {}, [el('tr',{},[
    el('th',{text:''}), el('th',{text:'Enabled'}), el('th',{text:'List (lsid)'}), el('th',{text:'Items'}),
    el('th',{text:'Default sort'})
  ])]);
  table.appendChild(thead);
  const tbody = el('tbody');

  function makeDrawer(lsid) {
    const tr = el('tr',{class:'drawer', 'data-drawer-for':lsid});
    const td = el('td',{colspan:'5'});
    td.appendChild(el('div',{text:'Loading…'}));
    tr.appendChild(td);
    getListItems(lsid).then(({items})=>{
      td.innerHTML = '';
      const tools = el('div', {class:'rowtools'});
      const saveBtn = el('button',{text:'Save order'});
      const resetBtn = el('button',{text:'Reset (list order)'});
      tools.appendChild(saveBtn); tools.appendChild(resetBtn);
      td.appendChild(tools);

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

  function makeRow(lsid) {
    const L = lists[lsid];
    const tr = el('tr', {'data-lsid': lsid, draggable:'true'});

    const chev = el('span',{class:'chev',text:'▾', title:'Open custom order'});
    const chevTd = el('td',{},[chev]);

    const cb = el('input', {type:'checkbox'}); cb.checked = enabledSet.has(lsid);
    cb.addEventListener('change', ()=>{ if (cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); });

    const nameCell = el('td',{});
    nameCell.appendChild(el('div',{text:(L.name||lsid)}));
    nameCell.appendChild(el('small',{text:lsid}));

    const count = el('td',{text:String((L.ids||[]).length)});

    const sortSel = el('select');
    const opts = ["custom","date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"];
    const def = (prefs.perListSort && prefs.perListSort[lsid]) || "name_asc";
    opts.forEach(o=> sortSel.appendChild(el('option',{value:o,text:o, ...(o===def?{selected:""}:{})})));
    sortSel.addEventListener('change', ()=>{ prefs.perListSort = prefs.perListSort || {}; prefs.perListSort[lsid] = sortSel.value; });

    tr.appendChild(chevTd);
    tr.appendChild(el('td',{},[cb]));
    tr.appendChild(nameCell);
    tr.appendChild(count);
    tr.appendChild(el('td',{},[sortSel]));

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

  const tbody = el('tbody');
  order.forEach(lsid => tbody.appendChild(makeRow(lsid)));
  table.appendChild(tbody);
  attachRowDnD(tbody);
  container.appendChild(table);

  const saveWrap = el('div',{style:'margin-top:10px;display:flex;gap:8px;align-items:center'});
  const saveBtn = el('button',{text:'Save'});
  const msg = el('span',{class:'inline-note'});
  saveWrap.appendChild(saveBtn); saveWrap.appendChild(msg);
  container.appendChild(saveWrap);

  saveBtn.onclick = async ()=>{
    const newOrder = Array.from(tbody.querySelectorAll('tr[data-lsid]')).map(tr => tr.getAttribute('data-lsid'));
    const enabled = Array.from(enabledSet);
    const body = {
      enabled,
      order: newOrder,
      defaultList: prefs.defaultList || (enabled[0] || ""),
      perListSort: prefs.perListSort || {},
      upgradeEpisodes: prefs.upgradeEpisodes || false
    };
    msg.textContent = "Saving…";
    const r = await fetch('/u/'+UID+'/api/prefs?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    const t = await r.text();
    msg.textContent = t || "Saved.";
    setTimeout(()=>{ msg.textContent = ""; }, 2500);
  };
}
render();
</script>
</body></html>`);
});

/* ----- Legacy single-user (optional) ----- */
if (LEGACY_IMDB_USER_URL && !process.env.DISABLE_LEGACY) {
  (async () => {
    const id = "legacy";
    let u = await loadUser(id);
    if (!u) {
      u = {
        uid: id,
        imdbUrl: LEGACY_IMDB_USER_URL,
        lists: {},
        prefs: { ...defaultPrefs(), upgradeEpisodes: LEGACY_UPGRADE_EPISODES },
        manifestRev: 1,
        lastSyncAt: 0,
        _lastManifestKey: ""
      };
      USERS.set(id, u);
      await saveUser(u);
    } else USERS.set(id, u);
    fullSync(u, { rediscover:true }).then(()=>scheduleNextSync(u));
  })();
}

/* ----- BOOT ----- */
app.listen(PORT, HOST, () => {
  console.log(`My Lists running on http://localhost:${PORT}`);
});
