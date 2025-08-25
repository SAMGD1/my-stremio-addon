// My Lists – IMDb snapshot add-on (stable)
// v8.4  — robust list scraping, clean ids only, manifest auto-bump, better syncing

const express = require("express");

// -------- ENV ----------
const PORT = Number(process.env.PORT) || 7000;
const HOST = "0.0.0.0";

const SHARED_SECRET  = process.env.SHARED_SECRET  || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_LISTS_JSON   = process.env.IMDB_LISTS || "[]";   // optional: [{"name":"Marvel Movies","url":"https://www.imdb.com/list/ls.../"}]
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

const CINEMETA = "https://v3-cinemeta.strem.io";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MyLists/8.4";

// -------- STATE ----------
/** { [name]: { url, ids: string[] } } */
let LISTS = Object.create(null);
/** Map<tt, { kind:'movie'|'series'|null, meta?:object }> */
const BEST = new Map();
/** last full sync time (ms) */
let LAST_SYNC_AT = 0;
/** manifest revision (bumps when list set changes so Stremio refreshes) */
let MANIFEST_REV = 1;
/** last list names key */
let LAST_LISTS_KEY = "";

let syncTimer = null;
let syncInProgress = false;

// -------- HELPERS ----------
function isImdb(v){ return /^tt\d{7,}$/i.test(String(v||"")); }
function nowIso(){ return new Date().toISOString(); }
function minutes(ms){ return Math.round(ms/60000); }
function minToMs(m){ return m*60*1000; }
function listsKey(){ return JSON.stringify(Object.keys(LISTS).sort()); }

async function fetchWithRetry(url, opts, tries = 3) {
  let lastErr;
  for (let i=0;i<tries;i++){
    try {
      const r = await fetch(url, Object.assign({ headers: { "User-Agent": UA }}, opts||{}));
      if (!r.ok) throw new Error("HTTP "+r.status);
      return r;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 300 + i*500));
    }
  }
  throw lastErr;
}
async function fetchText(url, accept){
  const r = await fetchWithRetry(url, { headers: accept ? { "User-Agent": UA, "Accept": accept } : undefined });
  return r.text();
}
async function fetchJson(url){
  const r = await fetchWithRetry(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  return r.json();
}

// -------- IMDb DISCOVERY ----------
function parseImdbListsEnv(){
  try {
    const arr = JSON.parse(IMDB_LISTS_JSON);
    return Array.isArray(arr) ? arr.filter(x => x && x.name && x.url) : [];
  } catch { return []; }
}

// find public lists on the user’s /lists/ page (cache-busted & resilient)
async function discoverListsFromUser(userListsUrl){
  if (!userListsUrl) return [];
  const u = new URL(userListsUrl);
  u.searchParams.set("_", String(Date.now())); // break IMDb caching
  const html = await fetchText(u.toString(), "text/html");

  // pick only /list/ls##########/ links that look like list cards/titles
  const map = new Map();
  let m;

  // 1) plain anchors inside list grid
  const reA = /<a[^>]+href="\/list\/(ls\d{6,})\/"[^>]*>([^<]+)<\/a>/gi;
  while ((m = reA.exec(html))) {
    const id = m[1];
    const name = m[2].replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
    if (name) map.set(id, { name, url: `https://www.imdb.com/list/${id}/` });
  }

  // 2) data-testid based (new UI)
  const reCard = /data-testid="listOverview-title".*?<a[^>]+href="\/list\/(ls\d{6,})\/"[^>]*>([^<]+)<\/a>/gis;
  while ((m = reCard.exec(html))) {
    const id = m[1];
    const name = m[2].replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
    if (name && !map.has(id)) map.set(id, { name, url: `https://www.imdb.com/list/${id}/` });
  }

  return Array.from(map.values());
}

// -------- IMDb LIST ITEMS (STRICT) ----------
// scope to the actual list container, then pull data-tconst per item only
function extractListBlock(html){
  const tries = [
    /<div[^>]+class="[^"]*\blister-list\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<ul[^>]+class="[^"]*\bipc-metadata-list\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i,
    /<section[^>]+data-testid="[^"]*list[^"]*"[^>]*>([\s\S]*?)<\/section>/i
  ];
  for (let i=0;i<tries.length;i++){
    const m = html.match(tries[i]);
    if (m && m[1]) return m[1];
  }
  return html;
}
function idsFromListHtmlStrict(html){
  const scoped = extractListBlock(html);
  const out = [];
  const seen = new Set();
  let m;

  // 1) preferred: data-tconst per card/row
  const reT = /data-tconst="(tt\d{7,})"/gi;
  while ((m = reT.exec(scoped))){
    const tt = m[1];
    if (!seen.has(tt)){ seen.add(tt); out.push(tt); }
  }

  // 2) classic lister rows (fallback)
  const reLister = /<div[^>]+class="[^"]*\blister-item\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  while ((m = reLister.exec(scoped))){
    const row = m[1];
    const idm = row.match(/href="\/title\/(tt\d{7,})\//i);
    if (idm){
      const tt = idm[1];
      if (!seen.has(tt)){ seen.add(tt); out.push(tt); }
    }
  }

  // DO NOT sweep whole page for /title/ links (that caused extra shows)
  return out;
}
function findNextListPage(html){
  let m = html.match(/<a[^>]+rel="next"[^>]+href="([^"]+)"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*lister-page-next[^"]*"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*data-testid="pagination-next-page-button"[^>]*>/i);
  if (!m) return null;
  try { return new URL(m[1], "https://www.imdb.com").toString(); } catch { return null; }
}
async function fetchListIdsAllPages(listUrl, maxPages=50){
  const seen = new Set();
  const ids = [];
  let url = new URL(listUrl);
  url.searchParams.set("_", String(Date.now()));    // cache-bust
  url.searchParams.set("mode", "detail");          // detail has data-tconst most often

  for (let p=0; p<maxPages; p++){
    let html;
    try { html = await fetchText(url.toString(), "text/html"); }
    catch { break; }

    const batch = idsFromListHtmlStrict(html);
    let added = 0;
    for (let i=0;i<batch.length;i++){
      const tt = batch[i];
      if (!seen.has(tt)){ seen.add(tt); ids.push(tt); added++; }
    }
    const next = findNextListPage(html);
    if (!next || added === 0) break;

    // carry forward cache-buster
    const n = new URL(next);
    n.searchParams.set("_", String(Date.now()));
    url = n;
  }
  return ids;
}

// -------- Cinemeta + fallback ----------
async function fetchCinemeta(kind, imdbId){
  try {
    const r = await fetchJson(`${CINEMETA}/meta/${encodeURIComponent(kind)}/${encodeURIComponent(imdbId)}.json`);
    return r && r.meta ? r.meta : null;
  } catch { return null; }
}
async function getBestMeta(imdbId){
  if (BEST.has(imdbId)) return BEST.get(imdbId);

  let meta = await fetchCinemeta("movie", imdbId);
  if (meta){ const rec = { kind: "movie", meta }; BEST.set(imdbId, rec); return rec; }

  meta = await fetchCinemeta("series", imdbId);
  if (meta){ const rec = { kind: "series", meta }; BEST.set(imdbId, rec); return rec; }

  const rec = { kind: null, meta: null };
  BEST.set(imdbId, rec);
  return rec;
}
async function mapLimit(arr, limit, fn){
  const res = new Array(arr.length);
  let i = 0;
  const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (i < arr.length){
      const idx = i++;
      res[idx] = await fn(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return res;
}

// snapshot card used by catalog responses
function makeCard(tt){
  const rec = BEST.get(tt) || { kind: "movie", meta: null };
  const meta = rec.meta;
  const card = { id: tt, type: rec.kind || "movie", name: meta && meta.name ? meta.name : tt };
  if (meta){
    if (meta.poster) card.poster = meta.poster;
    if (meta.background) card.background = meta.background;
    if (meta.logo) card.logo = meta.logo;
    if (meta.description) card.description = meta.description;

    if (meta.imdbRating != null) card.imdbRating = meta.imdbRating;
    else if (meta.rating != null) card.imdbRating = meta.rating;

    if (meta.runtime != null) card.runtime = meta.runtime;
    if (meta.year != null) card.year = meta.year;

    if (meta.releaseInfo != null) card.releaseDate = meta.releaseInfo;
    else if (meta.released != null) card.releaseDate = meta.released;
  }
  return card;
}

// -------- sort helpers ----------
function toTs(dateStr, year){
  if (dateStr){
    const t = Date.parse(dateStr);
    if (!Number.isNaN(t)) return t;
  }
  if (year){
    const t = Date.parse(String(year) + "-01-01");
    if (!Number.isNaN(t)) return t;
  }
  return null;
}
function stableSort(items, sortKey){
  const s   = String(sortKey || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const key = s.split("_")[0];

  function cmpNullBottom(a,b){
    const na = (a==null), nb=(b==null);
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return a<b?-1:a>b?1:0;
  }

  return items
    .map((m,i)=>({m,i}))
    .sort((A,B)=>{
      const a=A.m, b=B.m;
      let c=0;
      if (key==="date")    c = cmpNullBottom(toTs(a.releaseDate, a.year), toTs(b.releaseDate, b.year));
      else if (key==="rating")  c = cmpNullBottom(a.imdbRating, b.imdbRating);
      else if (key==="runtime") c = cmpNullBottom(a.runtime, b.runtime);
      else c = (a.name||"").localeCompare(b.name||"");
      if (c===0){
        c = (a.name||"").localeCompare(b.name||"");
        if (c===0) c = (a.id||"").localeCompare(b.id||"");
        if (c===0) c = A.i - B.i;
      }
      return c*dir;
    })
    .map(x=>x.m);
}

// -------- SYNC ----------
async function fullSync({ rediscover = true } = {}){
  if (syncInProgress) return;
  syncInProgress = true;
  const started = Date.now();
  try {
    // 1) discover lists
    let cfg = parseImdbListsEnv();
    if ((!cfg || cfg.length===0) && (IMDB_USER_URL && rediscover)){
      try { cfg = await discoverListsFromUser(IMDB_USER_URL); }
      catch (e){ console.warn("IMDb discovery failed:", e.message); cfg = []; }
    }

    // 2) pull ids strictly from each list
    const next = Object.create(null);
    const all = new Set();
    for (let i=0;i<cfg.length;i++){
      const L = cfg[i];
      let ids = [];
      try { ids = await fetchListIdsAllPages(L.url); }
      catch(e){ console.warn("List fetch failed:", L.name, e.message); }
      next[L.name] = { url: L.url, ids };
      for (let j=0;j<ids.length;j++) all.add(ids[j]);
    }

    // 3) preload Cinemeta for every unique id
    const every = Array.from(all);
    await mapLimit(every, 8, async (tt)=> { if (isImdb(tt)) await getBestMeta(tt); });

    LISTS = next;

    // 4) bump manifest rev if list set changed (adds/removes lists)
    const key = listsKey();
    if (key !== LAST_LISTS_KEY){
      LAST_LISTS_KEY = key;
      MANIFEST_REV++;
      console.log("[SYNC] catalogs changed → manifest rev", MANIFEST_REV);
    }

    LAST_SYNC_AT = Date.now();
    console.log(`[SYNC] ok – ${every.length} ids across ${Object.keys(LISTS).length} lists in ${minutes(LAST_SYNC_AT-started)} min`);
  } catch (e){
    console.error("[SYNC] failed:", e);
  } finally {
    syncInProgress = false;
  }
}
function scheduleNextSync(reset){
  if (syncTimer){ clearTimeout(syncTimer); syncTimer=null; }
  if (IMDB_SYNC_MINUTES<=0) return;
  const delay = minToMs(IMDB_SYNC_MINUTES);
  syncTimer = setTimeout(async ()=>{
    await fullSync({ rediscover:true });
    scheduleNextSync(true);
  }, reset?delay:delay);
}
function maybeBackgroundSync(){
  if (IMDB_SYNC_MINUTES<=0) return;
  const stale = Date.now()-LAST_SYNC_AT > minToMs(IMDB_SYNC_MINUTES);
  if (stale && !syncInProgress) fullSync({ rediscover:true }).then(()=>scheduleNextSync(true));
}

// kick off initial sync (non-blocking)
fullSync({ rediscover:true }).then(()=>scheduleNextSync(false));

// -------- SERVER ----------
const app = express();
app.use((_,res,next)=>{ res.setHeader("Access-Control-Allow-Origin","*"); next(); });

function addonAllowed(req){
  if (!SHARED_SECRET) return true;
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return u.searchParams.get("key") === SHARED_SECRET;
}
function adminAllowed(req){
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return (u.searchParams.get("admin") || req.headers["x-admin-key"]) === ADMIN_PASSWORD;
}
function absoluteBase(req){
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return `${proto}://${host}`;
}

app.get("/health", (_,res)=>res.status(200).send("ok"));

// Manifest (no-cache + auto version bump)
const baseManifest = {
  id: "org.my.csvlists",
  version: "8.4.0",
  name: "My Lists",
  description: "Your IMDb lists as instant catalogs. Opens real title pages so streams load.",
  resources: ["catalog","meta"],
  types: ["my lists","movie","series"],
  idPrefixes: ["tt"]
};
function catalogs(){
  const names = Object.keys(LISTS);
  return names.map(name => ({
    type: "My lists",
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
app.get("/manifest.json", (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma","no-cache");
    res.json(Object.assign({}, baseManifest, { version: baseManifest.version+"."+MANIFEST_REV, catalogs: catalogs() }));
  } catch(e){
    console.error("Manifest error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// helper to read extra params (from path + query)
function parseExtra(extraStr, queryObj){
  const params = new URLSearchParams(extraStr || "");
  const fromPath = Object.fromEntries(params.entries());
  return Object.assign({}, fromPath, queryObj || {});
}

// Catalog (instant from cache; default returns ALL items so you don’t get “only 25”)
app.get("/catalog/:type/:id/:extra?.json", async (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const id = req.params.id || "";
    if (!id.startsWith("list:")) return res.json({ metas: [] });

    const listName = id.slice(5);
    const list = LISTS[listName];
    if (!list || !list.ids || !list.ids.length) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q     = String(extra.search || "").toLowerCase().trim();
    const sort  = String(extra.sort || "name_asc").toLowerCase();
    // IGNORE incoming limit by default → show everything; Stremio can still page via skip/limit if it sends them.
    const skip  = Math.max(0, Number(extra.skip || 0));

    let metas = list.ids.map(makeCard);

    if (q){
      metas = metas.filter(m =>
        (m.name||"").toLowerCase().includes(q) ||
        (m.id||"").toLowerCase().includes(q)   ||
        (m.description||"").toLowerCase().includes(q)
      );
    }

    metas = stableSort(metas, sort);

    // if client provided a limit, respect it; otherwise show all from `skip`
    const limitParam = Number(extra.limit || 0);
    const page = limitParam > 0 ? metas.slice(skip, skip + limitParam) : metas.slice(skip);

    res.json({ metas: page });
  } catch(e){
    console.error("Catalog error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Meta (serve cached Cinemeta; fetch on demand if missing)
app.get("/meta/:type/:id.json", async (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const imdbId = req.params.id;
    if (!isImdb(imdbId))
      return res.json({ meta: { id: imdbId, type: "movie", name: "Unknown item" } });

    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);

    if (!rec || !rec.meta){
      return res.json({ meta: { id: imdbId, type: rec && rec.kind ? rec.kind : "movie", name: imdbId } });
    }
    res.json({ meta: Object.assign({}, rec.meta, { id: imdbId, type: rec.kind }) });
  } catch(e){
    console.error("Meta error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Admin
function absoluteManifestUrl(req){
  return `${absoluteBase(req)}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;
}
app.get("/admin", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");

  let discoveredHtml = `<p><small>${IMDB_USER_URL ? "No public lists found (or IMDb temporarily unreachable)." : "Set IMDB_USER_URL or IMDB_LISTS in your environment."}</small></p>`;
  if (IMDB_USER_URL){
    try {
      const lists = await discoverListsFromUser(IMDB_USER_URL);
      discoveredHtml = lists.length
        ? `<ul>${lists.map(x=>`<li><b>${x.name}</b><br/><small>${x.url}</small></li>`).join("")}</ul>`
        : discoveredHtml;
    } catch(_) {}
  }

  const uiLists = Object.keys(LISTS).length
    ? `<ul>${Object.entries(LISTS).map(([name,v]) => `<li><b>${name}</b> <small>(${(v.ids||[]).length} items)</small><br/><small>${v.url||""}</small></li>`).join("")}</ul>`
    : "<p>(no lists yet)</p>";

  res.type("html").send(`<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
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
    ${uiLists}
    <p><small>Last sync: ${LAST_SYNC_AT ? new Date(LAST_SYNC_AT).toLocaleString() + " (" + minutes(Date.now()-LAST_SYNC_AT) + " min ago)" : "never"}</small></p>
    <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}">
      <button class="btn2">Sync IMDb Lists Now</button>
    </form>
    <p><small>Auto-sync every ${IMDB_SYNC_MINUTES} min.</small></p>
  </div>

  <div class="card">
    <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
    ${discoveredHtml}
  </div>

  <div class="card">
    <h3>Manifest URL</h3>
    <p class="code">${absoluteManifestUrl(req)}</p>
  </div>
</body></html>`);
});

app.post("/api/sync", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    await fullSync({ rediscover:true });
    scheduleNextSync(true);
    res.status(200).send(`Synced at ${nowIso()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  } catch(e){
    console.error(e);
    res.status(500).send(String(e));
  }
});

// start
app.listen(PORT, HOST, ()=>{
  console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
});
