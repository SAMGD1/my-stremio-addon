// My Lists – IMDb → instant catalogs (simple + robust)
// - Discovers all public lists from IMDB_USER_URL (names + URLs)
// - Scrapes *all pages* of each list (no 25-item cap)
// - Preloads Cinemeta (movie → series) and falls back to IMDb title page
// - Catalogs are served from memory snapshot
// - Auto-sync every IMDB_SYNC_MINUTES; manual sync from /admin

const express = require("express");

// ---- ENV ----
const PORT = Number(process.env.PORT) || 10000;
const HOST = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_LISTS_JSON   = process.env.IMDB_LISTS || "[]";  // optional whitelist: [{"name":"Marvel Movies","url":"https://www.imdb.com/list/ls.../"}]
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

const CINEMETA = "https://v3-cinemeta.strem.io";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyLists/10.0";

function isTT(v){ return /^tt\d{7,}$/i.test(String(v||"")); }
async function fetchText(url){
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept":"text/html,*/*" }});
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url){
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept":"application/json" }});
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}
function withParam(url, k, v){ const u = new URL(url); u.searchParams.set(k, v); return u.toString(); }

// ---- STATE ----
/** { [name]: { url, ids: string[] } } */
let LISTS = {};
/** Map<tt, {kind:'movie'|'series'|null, meta:object|null}> */
const BEST = new Map();
/** Fallbacks Map<tt, {name?:string, poster?:string}> */
const FALLBACK = new Map();
/** Built cards Map<tt, card> for instant catalogs */
const CARDS = new Map();

let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;

// ---- DISCOVERY (get *names* + URLs from your user page) ----
function parseImdbListsEnv(){
  try {
    const x = JSON.parse(IMDB_LISTS_JSON);
    if (Array.isArray(x) && x.length) {
      return x.filter(v=>v && v.name && v.url).map(v=>({name:String(v.name), url:String(v.url)}));
    }
  } catch(_) {}
  return [];
}

// robustly pick list tiles from user page
async function discoverListsFromUser(userListsUrl){
  if (!userListsUrl) return [];
  const u = new URL(userListsUrl);
  u.searchParams.set("_", String(Date.now()));
  const html = await fetchText(u.toString());

  // IMDb uses multiple layouts; collect distinct ids + names
  const map = new Map();

  // classic anchor: <a href="/list/ls##########/">List Name</a>
  let m;
  const aRe = /<a[^>]+href="\/list\/(ls\d{6,})\/"[^>]*>(.*?)<\/a>/gi;
  while ((m = aRe.exec(html))) {
    const id = m[1];
    const name = m[2].replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
    if (name && !map.has(id)) map.set(id, { name, url: `https://www.imdb.com/list/${id}/` });
  }

  // grid card title fallback: data-testid="list-name" or aria labels
  const liRe = /<a[^>]+href="\/list\/(ls\d{6,})\/"[^>]*?(?:aria-label="([^"]+)"|data-testid="list-name"[^>]*>(.*?)<\/a>)/gi;
  while ((m = liRe.exec(html))) {
    const id = m[1];
    const name = (m[2] || m[3] || "").replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
    if (name && !map.has(id)) map.set(id, { name, url: `https://www.imdb.com/list/${id}/` });
  }

  // as a last resort, include id with placeholder name (admin will show the id string)
  if (map.size === 0) {
    const ids = Array.from(html.matchAll(/\/list\/(ls\d{6,})\//g)).map(x=>x[1]);
    const uniq = Array.from(new Set(ids));
    uniq.forEach(id => map.set(id, { name: id, url: `https://www.imdb.com/list/${id}/` }));
  }

  return Array.from(map.values());
}

// ---- LIST ITEMS (ALL PAGES, not only 25) ----
function tconstsFromHtml(html){
  const out = []; const seen = new Set();
  let m;
  // reliable marker in both old/new UI
  const reA = /data-tconst="(tt\d{7,})"/gi;
  while((m=reA.exec(html))){ const tt=m[1]; if(!seen.has(tt)){ seen.add(tt); out.push(tt); } }
  // fallback
  const reB = /\/title\/(tt\d{7,})\//gi;
  while((m=reB.exec(html))){ const tt=m[1]; if(!seen.has(tt)){ seen.add(tt); out.push(tt); } }
  return out;
}
function findNextUrl(html, base){
  let m = html.match(/<a[^>]+rel="next"[^>]+href="([^"]+)"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*lister-page-next[^"]*"/i);
  if (!m) m = html.match(/data-testid="pagination-next-page-button"[^>]*href="([^"]+)"/i);
  if (!m) return null;
  try { return new URL(m[1], base).toString(); } catch { return null; }
}
async function fetchAllTconsts(listUrl){
  // force "detail" first (most stable), then follow pagination
  let url = withParam(listUrl, "mode", "detail");
  const seen = new Set();
  const out = [];
  let pages = 0;

  while (url && pages < 200) {
    const html = await fetchText(withParam(url, "_", String(Date.now())));
    const ids = tconstsFromHtml(html);
    let added = 0;
    for (const tt of ids) if (!seen.has(tt)) { seen.add(tt); out.push(tt); added++; }
    pages++;
    const nxt = findNextUrl(html, "https://www.imdb.com");
    if (!nxt || added === 0) break;
    url = nxt;
  }
  return out;
}

// ---- Cinemeta + fallback ----
async function fetchCinemeta(kind, tt){
  try {
    const j = await fetchJson(`${CINEMETA}/meta/${encodeURIComponent(kind)}/${encodeURIComponent(tt)}.json`);
    return j && j.meta ? j.meta : null;
  } catch { return null; }
}
async function getBestMeta(tt){
  if (BEST.has(tt)) return BEST.get(tt);
  let meta = await fetchCinemeta("movie", tt);
  if (meta) { const rec = {kind:"movie", meta}; BEST.set(tt, rec); return rec; }
  meta = await fetchCinemeta("series", tt);
  if (meta) { const rec = {kind:"series", meta}; BEST.set(tt, rec); return rec; }
  const rec = {kind:null, meta:null}; BEST.set(tt, rec); return rec;
}

async function imdbTitleFallback(tt){
  try {
    const html = await fetchText(`https://www.imdb.com/title/${tt}/`);
    // JSON-LD
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        const node = Array.isArray(j && j["@graph"]) ? j["@graph"][0] : j;
        if (node) {
          const name = (node.name || node.headline || null);
          const img = (typeof node.image === "string" ? node.image : (node.image && node.image.url)) || null;
          return { name, poster: img };
        }
      } catch {}
    }
    // OpenGraph
    const t = html.match(/property="og:title"[^>]+content="([^"]+)"/i);
    const p = html.match(/property="og:image"[^>]+content="([^"]+)"/i);
    return { name: t ? t[1] : null, poster: p ? p[1] : null };
  } catch { return { name:null, poster:null }; }
}

function buildCard(tt){
  const rec = BEST.get(tt) || {kind:null, meta:null};
  const meta = rec.meta;
  const fb = FALLBACK.get(tt) || {};
  return {
    id: tt,
    type: rec.kind || "movie",
    name: (meta && meta.name) || fb.name || tt,
    poster: (meta && meta.poster) || fb.poster || undefined,
    background: meta && meta.background || undefined,
    logo: meta && meta.logo || undefined,
    imdbRating: meta && (meta.imdbRating ?? meta.rating) || undefined,
    runtime: meta && meta.runtime || undefined,
    year: meta && meta.year || undefined,
    releaseDate: meta && (meta.releaseInfo ?? meta.released) || undefined,
    description: meta && meta.description || undefined
  };
}

// ---- sort helpers ----
function toTs(d, y){
  if (d) { const t = Date.parse(d); if (!Number.isNaN(t)) return t; }
  if (y) { const t = Date.parse(`${y}-01-01`); if (!Number.isNaN(t)) return t; }
  return null;
}
function stableSort(items, sort){
  const s = String(sort||"name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const key = s.split("_")[0];

  const cmpNullBottom = (a,b)=>{
    const na=(a==null), nb=(b==null);
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return a<b?-1:a>b?1:0;
  };

  return items
    .map((m,i)=>({m,i}))
    .sort((A,B)=>{
      const a=A.m, b=B.m; let c=0;
      if (key==="date")    c = cmpNullBottom(toTs(a.releaseDate,a.year), toTs(b.releaseDate,b.year));
      else if (key==="rating")  c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
      else if (key==="runtime") c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
      else                      c = (a.name||"").localeCompare(b.name||"");
      if (c===0) { c=(a.name||"").localeCompare(b.name||""); if(c===0) c=(a.id||"").localeCompare(b.id||""); if(c===0) c=A.i-B.i; }
      return c*dir;
    })
    .map(x=>x.m);
}

// ---- FULL SYNC ----
async function fullSync({ rediscover=true } = {}){
  if (syncInProgress) return;
  syncInProgress = true;
  try {
    // 1) determine the lists
    let cfg = parseImdbListsEnv();
    if ((!cfg || cfg.length===0) && IMDB_USER_URL && rediscover) {
      try { cfg = await discoverListsFromUser(IMDB_USER_URL); }
      catch(e){ console.warn("Discovery failed:", e.message); cfg = []; }
    }

    // 2) fetch all tt ids for each list (ALL PAGES)
    const nextLists = {};
    const all = new Set();
    for (const L of cfg) {
      let ids = [];
      try { ids = await fetchAllTconsts(L.url); } catch(e){ console.warn("List fetch failed:", L.name, e.message); }
      nextLists[L.name] = { url: L.url, ids };
      ids.forEach(id=>all.add(id));
    }
    LISTS = nextLists;

    // 3) preload meta (movie→series)
    const idsAll = Array.from(all);
    // small concurrency
    const limit = 8;
    let i=0; const runners = Array(Math.min(limit, idsAll.length)).fill(0).map(async ()=>{
      while(i<idsAll.length){
        const idx = i++; const tt = idsAll[idx];
        if (!isTT(tt)) continue;
        const rec = await getBestMeta(tt);
        // fill fallback name/poster if Cinemeta didn’t have them
        const weakName   = !rec.meta || !rec.meta.name;
        const weakPoster = !rec.meta || !rec.meta.poster;
        if (weakName || weakPoster) {
          const fb = await imdbTitleFallback(tt);
          if (fb.name || fb.poster) {
            const cur = FALLBACK.get(tt) || {};
            if (fb.name && !cur.name) cur.name = fb.name;
            if (fb.poster && !cur.poster) cur.poster = fb.poster;
            FALLBACK.set(tt, cur);
          }
        }
        CARDS.set(tt, buildCard(tt));
      }
    });
    await Promise.all(runners);

    LAST_SYNC_AT = Date.now();
    console.log(`[SYNC] ok – ${idsAll.length} ids across ${Object.keys(LISTS).length} lists in 0 min`);
  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally { syncInProgress = false; }
}

function scheduleNextSync(reset=false){
  if (syncTimer) { clearTimeout(syncTimer); syncTimer=null; }
  if (IMDB_SYNC_MINUTES<=0) return;
  const delay = IMDB_SYNC_MINUTES*60*1000;
  syncTimer = setTimeout(async ()=>{ await fullSync({rediscover:true}); scheduleNextSync(true); }, reset?delay:delay);
}

// ---- SERVER ----
const app = express();
app.use((_,res,next)=>{ res.setHeader("Access-Control-Allow-Origin","*"); next(); });

function addonAllowed(req){
  if (!SHARED_SECRET) return true;
  const url = new URL(req.originalUrl, `http://${req.headers.host}`);
  return url.searchParams.get("key") === SHARED_SECRET;
}
function adminAllowed(req){
  const url = new URL(req.originalUrl, `http://${req.headers.host}`);
  return (url.searchParams.get("admin") || req.headers["x-admin-key"]) === ADMIN_PASSWORD;
}
function absoluteBase(req){
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

app.get("/health",(_,res)=>res.status(200).send("ok"));

// Manifest
const baseManifest = {
  id: "org.my.csvlists",
  version: "10.0.0",
  name: "My Lists",
  description: "Your IMDb lists as instant Stremio catalogs.",
  resources: ["catalog", "meta"],
  types: ["my lists","movie","series"],
  idPrefixes: ["tt"]
};
function catalogs(){
  return Object.keys(LISTS).map(name=>({
    type: "My lists",
    id: `list:${name}`,
    name: `🗂 ${name}`,
    extraSupported: ["search","skip","limit","sort"],
    extra: [
      {name:"search"},{name:"skip"},{name:"limit"},
      {name:"sort", options:["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"]}
    ],
    posterShape:"poster"
  }));
}
app.get("/manifest.json",(req,res)=>{
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    res.json({ ...baseManifest, catalogs: catalogs() });
  } catch(e){ console.error("manifest",e); res.status(500).send("Internal Error"); }
});

// Catalog
function parseExtra(extraStr, query){
  const params = new URLSearchParams(extraStr||"");
  return { ...Object.fromEntries(params.entries()), ...(query||{}) };
}
app.get("/catalog/:type/:id/:extra?.json", async (req,res)=>{
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    const { id } = req.params;
    if (!id || !id.startsWith("list:")) return res.json({ metas: [] });

    const listName = id.slice(5);
    const list = LISTS[listName];
    if (!list || !list.ids || !list.ids.length) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q     = String(extra.search||"").toLowerCase().trim();
    const sort  = String(extra.sort||"name_asc").toLowerCase();
    const skip  = Math.max(0, Number(extra.skip||0));
    const limit = Math.min(Number(extra.limit||100), 200);

    let metas = list.ids.map(tt=>{
      const card = CARDS.get(tt) || buildCard(tt);
      return card;
    });

    if (q) {
      metas = metas.filter(m =>
        (m.name||"").toLowerCase().includes(q) ||
        (m.description||"").toLowerCase().includes(q) ||
        (m.id||"").toLowerCase().includes(q)
      );
    }

    metas = stableSort(metas, sort);
    res.json({ metas: metas.slice(skip, skip+limit) });
  } catch(e){ console.error("catalog",e); res.status(500).send("Internal Error"); }
});

// Meta
app.get("/meta/:type/:id.json", async (req,res)=>{
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    const tt = req.params.id;
    if (!isTT(tt)) return res.json({ meta: { id: tt, type:"movie", name:"Unknown item" }});
    let rec = BEST.get(tt);
    if (!rec) rec = await getBestMeta(tt);
    if (!rec || !rec.meta) {
      const fb = FALLBACK.get(tt) || {};
      return res.json({ meta: { id: tt, type: rec?.kind || "movie", name: fb.name || tt, poster: fb.poster || undefined }});
    }
    res.json({ meta: { ...rec.meta, id: tt, type: rec.kind }});
  } catch(e){ console.error("meta",e); res.status(500).send("Internal Error"); }
});

// Admin
app.get("/admin", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  let discovered = [];
  try { if (IMDB_USER_URL) discovered = await discoverListsFromUser(IMDB_USER_URL); } catch {}
  const manifestUrl = `${absoluteBase(req)}/manifest.json${SHARED_SECRET?`?key=${SHARED_SECRET}`:""}`;
  const currentHtml = Object.entries(LISTS).length
    ? `<ul>${Object.entries(LISTS).map(([n,v])=>`<li><b>${n}</b> (${(v.ids||[]).length} items)<br><small>${v.url}</small></li>`).join("")}</ul>`
    : "<p>(none)</p>";
  res.type("html").send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>My Lists – Admin</title>
<style>body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:760px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
button{padding:10px 16px;border:0;border-radius:8px;background:#2d6cdf;color:#fff;cursor:pointer}
small{color:#666}.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}</style>
</head><body>
<h1>My Lists – Admin</h1>
<div class="card">
  <h3>Current Snapshot</h3>
  ${currentHtml}
  <p><small>Last sync: ${LAST_SYNC_AT? new Date(LAST_SYNC_AT).toLocaleString() + " (" + Math.round((Date.now()-LAST_SYNC_AT)/60000) + " min ago)" : "never"}</small></p>
  <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}"><button>Sync IMDb Lists Now</button></form>
  <p><small>Auto-sync every ${IMDB_SYNC_MINUTES} min.</small></p>
</div>
<div class="card">
  <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
  ${discovered.length ? `<ul>${discovered.map(x=>`<li><b>${x.name}</b><br><small>${x.url}</small></li>`).join("")}</ul>` : "<p><small>No public lists found (or IMDb unreachable right now).</small></p>"}
</div>
<div class="card">
  <h3>Manifest URL</h3>
  <p class="code">${manifestUrl}</p>
</div>
</body></html>`);
});

app.post("/api/sync", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try { await fullSync({rediscover:true}); scheduleNextSync(true); res.status(200).send(`Synced. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`); }
  catch(e){ res.status(500).send(String(e)); }
});

// ---- BOOT ----
fullSync({rediscover:true}).then(()=>scheduleNextSync(false));

app.listen(PORT, HOST, ()=>{
  console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET?`?key=${SHARED_SECRET}`:""}`);
});
