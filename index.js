/* My Lists – Public Multi-Tenant (IMDb → Stremio)
 * v2.0.0
 * - Self-serve landing page
 * - Per-user admin/customize
 * - Unique manifest links
 * - Optional GitHub JSON persistence
 */

"use strict";
const express = require("express");

// ---------------- ENV ----------------
const PORT = Number(process.env.PORT || 7000);
const HOST = "0.0.0.0";

const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD || "Stremio_172"; // used only on /health & debug
const DEFAULT_SYNC_MIN = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60)); // minutes
const UPGRADE_DEFAULT  = String(process.env.UPGRADE_EPISODES || "true").toLowerCase() !== "false";
const SHARED_SECRET    = process.env.SHARED_SECRET || ""; // optional: if set, only manifests with ?key= allowed

// Optional GitHub persistence (same style you used before)
const GH_OWNER  = process.env.GITHUB_OWNER  || ""; // e.g. SAMGD1
const GH_REPO   = process.env.GITHUB_REPO   || process.env.GITHUB_REPO_NAME || "my-stremio-addon-data";
const GH_BRANCH = process.env.GITHUB_BRANCH || "main";
const GH_TOKEN  = process.env.GITHUB_TOKEN  || "";

// ---------------- CONSTS ----------------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};
const CINEMETA = "https://v3-cinemeta.strem.io";

// ---------------- GLOBAL CACHES (by imdb id) ----------------
const BEST = new Map();     // Map<tt, {kind:'movie'|'series', meta:object|null}>
const FALLBACK = new Map(); // Map<tt, { name?, poster?, releaseDate?, year?, type? }>
const EP2SER = new Map();   // Map<episode_tt, series_tt>

// ---------------- TENANT RUNTIME ----------------
// In-memory registry (ephemeral); persisted in GitHub if configured
// userObj = { uid, key, imdbUserUrl, extraListIds[], enabled[], order[], perListSort{}, defaultList?, upgradeEpisodes, syncMinutes, lastSyncAt?, lists{} }
const USERS = new Map();    // Map<uid, userObj>
const SYNC_LOCK = new Set();// uid currently syncing
let MANIFEST_REV = 1;       // bump to force Stremio to re-pull manifests

// ---------------- HELPERS ----------------
const isImdb = v => /^tt\d{7,}$/i.test(String(v||""));
const isListId = v => /^ls\d{6,}$/i.test(String(v||""));
const minutes = ms => Math.round(ms/60000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

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
const clamp = (v,min,max)=>Math.max(min,Math.min(max,v));

// ---------------- GitHub persistence (optional) ----------------
const GH_OK = !!(GH_OWNER && GH_REPO && GH_BRANCH && GH_TOKEN);

async function ghRead(path) {
  if (!GH_OK) return null;
  const api = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`;
  const r = await fetch(api, { headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept": "application/vnd.github+json" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub read ${path}: ${r.status}`);
  const j = await r.json();
  const b64 = j.content || "";
  const raw = Buffer.from(b64, "base64").toString("utf8");
  return { content: raw, sha: j.sha };
}
async function ghWrite(path, content, message) {
  if (!GH_OK) return;
  const existing = await ghRead(path).catch(()=>null);
  const api = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}`;
  const body = {
    message: message || `update ${path} @ ${nowIso()}`,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch: GH_BRANCH
  };
  if (existing && existing.sha) body.sha = existing.sha;
  const r = await fetch(api, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept": "application/vnd.github+json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`GitHub write ${path}: ${r.status}`);
}

// ---------------- IMDb discovery & scraping ----------------
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(withParam(userListsUrl, "_", Date.now()));
  const re = /href=['"](?:https?:\/\/(?:www\.)?imdb\.com)?\/list\/(ls\d{6,})\/['"]/gi;
  const ids = new Set();
  let m;
  while ((m = re.exec(html))) ids.add(m[1]);
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
      await sleep(80);
    }
    if (ids.length) break;
  }
  return ids;
}

// ---------------- metadata ----------------
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

// ---------------- USER STORAGE ----------------
function userPath(uid){ return `users/${uid}.json`; }
function randomId(n=16){ return [...crypto.getRandomValues(new Uint8Array(n))].map(b=>b.toString(16).padStart(2,"0")).join(""); }
function uidShort(){ return Math.random().toString(36).slice(2,10); }

// load/save user (GitHub if configured, otherwise memory only)
async function loadUser(uid){
  if (USERS.has(uid)) return USERS.get(uid);
  if (!GH_OK) return null;
  const res = await ghRead(userPath(uid)).catch(()=>null);
  if (!res || !res.content) return null;
  try { const u = JSON.parse(res.content); USERS.set(uid, u); return u; } catch { return null; }
}
async function saveUser(u){
  USERS.set(u.uid, u);
  if (GH_OK) await ghWrite(userPath(u.uid), JSON.stringify(u, null, 2), `save ${u.uid}`);
}

// ---------------- SYNC PER-USER ----------------
async function fullSyncForUser(u, { rediscover = true, purge = false } = {}) {
  if (SYNC_LOCK.has(u.uid)) return;
  SYNC_LOCK.add(u.uid);
  const started = Date.now();
  try {
    if (purge) { u.lists = {}; u.lastSyncAt = 0; }

    let discovered = [];
    if (u.imdbUserUrl && rediscover) {
      try { discovered = await discoverListsFromUser(u.imdbUserUrl); }
      catch (e) { console.warn(`[DISCOVER][${u.uid}] failed:`, e.message); }
    }

    // Allow extra list ids (manual merge)
    const extras = Array.isArray(u.extraListIds) ? u.extraListIds : [];
    for (const id of extras) {
      if (isListId(id) && !discovered.find(d=>d.id===id)) {
        discovered.push({ id, url:`https://www.imdb.com/list/${id}/`, name:id });
      }
    }

    // carry old lists forward if not rediscovered
    const next = Object.create(null);
    const seen = new Set();
    for (const d of discovered) { next[d.id] = { id:d.id, name:d.name || d.id, url:d.url, ids:[] }; seen.add(d.id); }
    for (const id of Object.keys(u.lists||{})) if (!seen.has(id)) next[id] = u.lists[id];

    // fetch ids per list
    const uniques = new Set();
    for (const id of Object.keys(next)) {
      const url = next[id].url || `https://www.imdb.com/list/${id}/`;
      let ids = [];
      try { ids = await fetchImdbListIdsAllPages(url); } catch {}
      next[id].ids = ids;
      ids.forEach(tt => uniques.add(tt));
      await sleep(50);
    }

    // upgrade episodes → series if selected
    let idsToPreload = Array.from(uniques);
    if (u.upgradeEpisodes !== false) {
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

    // preload metadata (parallel)
    const limit = 8;
    const out = new Array(idsToPreload.length);
    let i = 0;
    const runners = new Array(Math.min(limit, idsToPreload.length)).fill(0).map(async () => {
      while (i < idsToPreload.length) {
        const idx = i++; out[idx] = await getBestMeta(idsToPreload[idx]);
      }
    });
    await Promise.all(runners);

    u.lists = next;
    u.lastSyncAt = Date.now();

    await saveUser(u);
    MANIFEST_REV++;
    console.log(`[SYNC][${u.uid}] ok – ${idsToPreload.length} ids across ${Object.keys(u.lists).length} lists in ${minutes(Date.now()-started)} min`);
  } catch (e) {
    console.error(`[SYNC][${u.uid}] failed:`, e);
  } finally {
    SYNC_LOCK.delete(u.uid);
  }
}
function maybeBackgroundSync(u){
  const mins = clamp(Number(u.syncMinutes || DEFAULT_SYNC_MIN), 2, 720);
  const stale = !u.lastSyncAt || (Date.now() - u.lastSyncAt > mins*60*1000);
  if (stale && !SYNC_LOCK.has(u.uid)) fullSyncForUser(u, { rediscover: true });
}

// ---------------- SERVER ----------------
const app = express();
app.use(express.json());
app.use((_, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });

function absoluteBase(req){
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

// -------- LANDING PAGE --------
app.get("/", (req,res)=>{
  const base = absoluteBase(req);
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>My Lists for Stremio – Create</title>
<style>
:root{--bg1:#1b1230;--bg2:#2b1956;--accent:#8b5cf6;--text:#eee;--muted:#a5a1b3;}
html,body{margin:0;padding:0;background:radial-gradient(1200px 600px at 20% -20%,var(--bg2),var(--bg1));color:var(--text);font:15px/1.4 system-ui,Segoe UI,Roboto,Arial}
.header{display:flex;align-items:center;gap:12px;padding:28px}
.logo{width:28px;height:28px;border-radius:6px;background:#673ab7;display:inline-block}
.container{max-width:940px;margin:0 auto;padding:16px}
.card{background:rgba(255,255,255,0.06);backdrop-filter: blur(4px);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:20px}
h1{font-size:28px;margin:8px 0 16px}
small{color:var(--muted)}
input,button{font:inherit}
input[type=text]{width:100%;padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.25);color:var(--text)}
.row{display:flex;gap:12px;align-items:center;margin-top:12px}
button{padding:10px 16px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:rgba(0,0,0,.35);padding:6px 8px;border-radius:8px}
.link{color:#fff;text-decoration:none;border-bottom:1px solid rgba(255,255,255,.3)}
.fade{animation:fadein .5s ease}
@keyframes fadein{from{opacity:.001; transform:translateY(6px)}to{opacity:1; transform:none}}
</style>
</head>
<body>
<div class="header"><span class="logo"></span><div><b>My Lists for Stremio</b><br/><small>Paste your IMDb lists URL, get a unique manifest</small></div></div>
<div class="container">
  <div class="card fade">
    <h1>Create your personal addon</h1>
    <label>IMDb lists URL (e.g. <span class="code">https://www.imdb.com/user/urXXXX/lists/</span> or a single list URL)</label>
    <input id="imdb" type="text" placeholder="https://www.imdb.com/user/ur12345678/lists/" />
    <div class="row">
      <button id="go">Create</button>
      <small id="msg"></small>
    </div>
    <div id="result" style="display:none;margin-top:16px">
      <p><b>Admin:</b> <a id="admin" class="link" target="_blank" rel="noopener">open</a></p>
      <p><b>Manifest URL:</b> <span class="code" id="manifest"></span></p>
      <div class="row"><button id="copy">Copy manifest</button></div>
    </div>
  </div>
  <p style="opacity:.8;margin-top:18px"><small>Tip: you can add extra list IDs later in Admin to merge other users' lists into yours.</small></p>
</div>
<script>
async function create() {
  const imdb = document.getElementById('imdb').value.trim();
  const msg = document.getElementById('msg'); msg.textContent = 'Creating…';
  const r = await fetch('/api/create', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ imdbUrl: imdb })});
  if (!r.ok) { msg.textContent = 'Failed: ' + (await r.text()); return; }
  const j = await r.json();
  msg.textContent = 'Done!';
  const admin = document.getElementById('admin');
  const manifest = document.getElementById('manifest');
  admin.href = j.adminUrl; admin.textContent = j.adminUrl;
  manifest.textContent = j.manifestUrl;
  document.getElementById('result').style.display = '';
  document.getElementById('copy').onclick = async ()=>{ await navigator.clipboard.writeText(j.manifestUrl); msg.textContent='Copied!'; setTimeout(()=>msg.textContent='',1500); }
}
document.getElementById('go').onclick = create;
</script>
</body></html>`);
});

// create user
app.post("/api/create", async (req,res)=>{
  try{
    const imdbUrl = String((req.body && req.body.imdbUrl) || "").trim();
    let imdbUserUrl = "";
    let extraListIds = [];

    if (!imdbUrl) return res.status(400).send("No URL");

    // accept either /user/ur.../lists/ or /list/ls.../
    if (/\/user\/ur\d+\/lists\//i.test(imdbUrl)) {
      imdbUserUrl = imdbUrl.replace(/^\s+|\s+$/g,"");
    } else {
      const m = imdbUrl.match(/\/list\/(ls\d{6,})/i);
      if (!m) return res.status(400).send("Provide a valid IMDb user lists URL or list URL.");
      extraListIds.push(m[1]);
    }

    const uid = uidShort();
    const key = randomId(12);
    const u = {
      uid, key,
      imdbUserUrl,
      extraListIds,
      enabled: [], order: [],
      perListSort: {}, defaultList: null,
      upgradeEpisodes: UPGRADE_DEFAULT,
      syncMinutes: DEFAULT_SYNC_MIN,
      lastSyncAt: 0,
      lists: {}
    };
    await saveUser(u);
    // kick off discovery+sync async
    fullSyncForUser(u, { rediscover: true });

    const base = absoluteBase(req);
    const q = `?key=${u.key}`;
    res.json({
      uid,
      adminUrl: `${base}/u/${uid}/admin${q}`,
      manifestUrl: `${base}/u/${uid}/manifest.json${q}`
    });
  }catch(e){ res.status(500).send(String(e)); }
});

// -------- Per-user helpers --------
async function requireUser(req, res){
  const u = await loadUser(req.params.uid);
  if (!u) { res.status(404).send("Unknown user."); return null; }
  const key = (req.query.key || req.headers["x-addon-key"] || "").toString();
  if ((SHARED_SECRET && key !== SHARED_SECRET) && key !== u.key) { res.status(403).send("Forbidden (bad key)."); return null; }
  return u;
}

// -------- Admin UI per user --------
app.get("/u/:uid/admin", async (req,res)=>{
  const u = await requireUser(req,res); if (!u) return;
  maybeBackgroundSync(u);
  const base = absoluteBase(req);
  const k = `?key=${encodeURIComponent(u.key)}`;
  const last = u.lastSyncAt ? (new Date(u.lastSyncAt).toLocaleString() + " (" + minutes(Date.now()-u.lastSyncAt) + " min ago)") : "never";

  // build rows
  const rows = Object.keys(u.lists||{}).map(id=>{
    const L = u.lists[id];
    const count=(L.ids||[]).length;
    const def = (u.perListSort && u.perListSort[id]) || "date_asc";
    const enabled = (u.enabled && u.enabled.length) ? u.enabled.includes(id) : true;
    return `<tr data-lsid="${id}">
      <td><input type="checkbox" ${enabled?"checked":""}/></td>
      <td><div>${L.name||id}</div><small>${id}</small></td>
      <td>${count}</td>
      <td>
        <select>
          ${["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"].map(o=>`<option value="${o}" ${o===def?"selected":""}>${o}</option>`).join("")}
        </select>
      </td>
    </tr>`;
  }).join("") || "";

  const disc = (await (async ()=>{
    try{
      const d = await discoverListsFromUser(u.imdbUserUrl || "");
      return d.map(x=>`<li><b>${x.name||x.id}</b><br/><small>${x.url}</small></li>`).join("");
    }catch{return "";}
  })());
  res.type("html").send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Admin (${u.uid})</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:1000px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
small{color:#666}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}
button{padding:10px 16px;border:0;border-radius:8px;background:#2d6cdf;color:#fff;cursor:pointer}
table{width:100%;border-collapse:collapse}
th,td{border-top:1px solid #eee;padding:8px;text-align:left}
tbody tr[draggable="true"]{cursor:grab}
tbody tr.dragging{opacity:.5}
input[type=text]{width:100%;padding:8px;border:1px solid #ddd;border-radius:8px}
</style></head><body>
<h1>My Lists – Admin</h1>

<div class="card">
  <h3>Current Snapshot</h3>
  <ul>${Object.keys(u.lists||{}).map(id=>`<li><b>${u.lists[id]?.name||id}</b> <small>(${(u.lists[id]?.ids||[]).length} items)</small><br/><small>${u.lists[id]?.url||""}</small></li>`).join("")||"<li>(none)</li>"}</ul>
  <p><small>Last sync: ${last}</small></p>
  <div class="row">
    <form method="POST" action="/u/${u.uid}/api/sync${k}" style="display:inline"><button>Sync IMDb Lists Now</button></form>
    <form method="POST" action="/u/${u.uid}/api/purge${k}" style="display:inline"><button style="background:#b4231a">Purge & Sync</button></form>
    <span class="code">Auto-sync every ${u.syncMinutes || ${DEFAULT_SYNC_MIN}} min</span>
  </div>
</div>

<div class="card">
  <h3>Customize (enable/disable, order, defaults)</h3>
  <div style="margin-bottom:8px"><b>Default list:</b>
    <select id="defSel">${Object.keys(u.lists||{}).map(id=>`<option value="${id}" ${id===u.defaultList?"selected":""}>${u.lists[id]?.name||id}</option>`).join("")}</select>
  </div>
  <label><input id="upgrade" type="checkbox" ${u.upgradeEpisodes!==false?"checked":""}/> Upgrade episodes to parent series</label>

  <table style="margin-top:8px">
    <thead><tr><th>Enabled</th><th>List (lsid)</th><th>Items</th><th>Default sort</th></tr></thead>
    <tbody id="tbody">${rows}</tbody>
  </table>

  <div style="margin-top:12px">
    <button id="saveBtn">Save</button>
    <span id="saveMsg" style="color:#2d6cdf;margin-left:10px"></span>
  </div>
</div>

<div class="card">
  <h3>Merge extra lists</h3>
  <p><small>Add IMDb list IDs (lsXXXX) or list URLs, comma-separated. They will be merged with your lists on next sync.</small></p>
  <input id="extra" type="text" placeholder="ls123456789, https://www.imdb.com/list/ls987654321/" value="${(u.extraListIds||[]).join(", ")}"/>
  <div style="margin-top:8px"><button id="saveExtra">Save & Sync</button></div>
</div>

<div class="card">
  <h3>Discovered at <span class="code">${u.imdbUserUrl || "(not set)"}</span></h3>
  <ul>${disc || "<li>(none found or IMDb unreachable right now).</li>"}</ul>
</div>

<div class="card">
  <h3>Manifest URL</h3>
  <p class="code">${base}/u/${u.uid}/manifest.json?key=${u.key}</p>
</div>

<script>
function isCtrl(node){const t=(node&&node.tagName||"").toLowerCase();return t==="input"||t==="select"||t==="button"||t==="a"||t==="label";}
function attachDnD(tbody){
  let dragSrc=null;
  tbody.addEventListener('dragstart', e=>{const tr=e.target.closest('tr[data-lsid]'); if(!tr||isCtrl(e.target)) return; dragSrc=tr; tr.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', tr.dataset.lsid||'');});
  tbody.addEventListener('dragend', ()=>{ if(dragSrc) dragSrc.classList.remove('dragging'); dragSrc=null; });
  tbody.addEventListener('dragover', e=>{ e.preventDefault(); if(!dragSrc) return; const over=e.target.closest('tr[data-lsid]'); if(!over||over===dragSrc) return; const r=over.getBoundingClientRect(); const before=(e.clientY-r.top)<r.height/2; over.parentNode.insertBefore(dragSrc, before?over:over.nextSibling);});
}
attachDnD(document.getElementById('tbody'));

document.getElementById('saveBtn').onclick = async ()=>{
  const tbody=document.getElementById('tbody');
  const order=[...tbody.querySelectorAll('tr[data-lsid]')].map(tr=>tr.getAttribute('data-lsid'));
  const enabled=order.filter((id,i)=> tbody.children[i].querySelector('input[type=checkbox]').checked);
  const sorts={}; order.forEach((id,i)=>{ sorts[id]=tbody.children[i].querySelector('select').value; });
  const body={enabled, order, defaultList:document.getElementById('defSel').value, perListSort:sorts, upgradeEpisodes:document.getElementById('upgrade').checked};
  const msg=document.getElementById('saveMsg'); msg.textContent='Saving…';
  const r=await fetch('/u/${u.uid}/api/prefs${k}', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  msg.textContent=await r.text();
  setTimeout(()=>msg.textContent='',2500);
};

document.getElementById('saveExtra').onclick = async ()=>{
  const val=document.getElementById('extra').value.trim();
  const r=await fetch('/u/${u.uid}/api/extra${k}', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({value:val})});
  alert(await r.text());
  location.reload();
};
</script>

</body></html>`);
});

// prefs save
app.post("/u/:uid/api/prefs", async (req,res)=>{
  const u = await requireUser(req,res); if (!u) return;
  try{
    u.enabled = Array.isArray(req.body.enabled) ? req.body.enabled.filter(isListId) : u.enabled;
    u.order = Array.isArray(req.body.order) ? req.body.order.filter(isListId) : u.order;
    u.perListSort = typeof req.body.perListSort === "object" ? req.body.perListSort : u.perListSort;
    u.defaultList = isListId(req.body.defaultList) ? req.body.defaultList : (u.defaultList||null);
    u.upgradeEpisodes = !!req.body.upgradeEpisodes;
    await saveUser(u);
    MANIFEST_REV++;
    res.send(`Saved. Manifest rev ${MANIFEST_REV}`);
  }catch(e){ res.status(500).send(String(e)); }
});

// extra lists merge
app.post("/u/:uid/api/extra", async (req,res)=>{
  const u = await requireUser(req,res); if (!u) return;
  try{
    const raw = String((req.body && req.body.value) || "");
    const ids = [];
    raw.split(/[, \n\r]+/).forEach(tok=>{
      if (!tok) return;
      const m = tok.match(/(ls\d{6,})/i);
      if (m) ids.push(m[1]);
    });
    u.extraListIds = Array.from(new Set(ids));
    await saveUser(u);
    MANIFEST_REV++;
    res.send(`Saved ${u.extraListIds.length} extra list(s). Will appear after next sync.`);
  }catch(e){ res.status(500).send(String(e)); }
});

// sync + purge
app.post("/u/:uid/api/sync", async (req,res)=>{
  const u = await requireUser(req,res); if (!u) return;
  try{ await fullSyncForUser(u, { rediscover:true }); res.send(`Synced at ${nowIso()}`); } catch (e){ res.status(500).send(String(e)); }
});
app.post("/u/:uid/api/purge", async (req,res)=>{
  const u = await requireUser(req,res); if (!u) return;
  try{ await fullSyncForUser(u, { rediscover:true, purge:true }); res.send(`Purged & synced at ${nowIso()}`); } catch (e){ res.status(500).send(String(e)); }
});

// -------- Stremio: manifest / catalog / meta (per user) --------
function catalogsForUser(u){
  // choose visible order: saved order (enabled first), else alphabetical
  const ids = (u.order && u.order.length ? u.order : Object.keys(u.lists||{}));
  const enabledSet = new Set((u.enabled && u.enabled.length) ? u.enabled : ids);
  const ordered = ids.filter(id => enabledSet.has(id));
  return ordered.map(lsid => ({
    type: "My lists",
    id: `list:${lsid}`,
    name: `🗂 ${u.lists[lsid]?.name || lsid}`,
    extraSupported: ["search","skip","limit","sort"],
    extra: [
      { name:"search" }, { name:"skip" }, { name:"limit" },
      { name:"sort", options:["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"] }
    ],
    posterShape: "poster"
  }));
}
const baseManifest = {
  id: "org.mylists.public",
  version: "2.0.0",
  name: "My Lists (per-user)",
  description: "Your own IMDb lists → Stremio catalogs.",
  resources: ["catalog","meta"],
  types: ["my lists","movie","series"],
  idPrefixes: ["tt"]
};
app.get("/u/:uid/manifest.json", async (req,res)=>{
  const u = await requireUser(req,res); if (!u) return;
  maybeBackgroundSync(u);
  const m = { ...baseManifest, version: `${baseManifest.version}-${MANIFEST_REV}`, catalogs: catalogsForUser(u) };
  res.json(m);
});

function parseExtra(extraStr, qObj){
  const p = new URLSearchParams(extraStr||"");
  return { ...Object.fromEntries(p.entries()), ...(qObj||{}) };
}
app.get("/u/:uid/catalog/:type/:id/:extra?.json", async (req,res)=>{
  const u = await requireUser(req,res); if (!u) return;
  maybeBackgroundSync(u);
  try{
    const { id } = req.params;
    if (!id || !id.startsWith("list:")) return res.json({ metas: [] });
    const lsid = id.slice(5);
    const list = u.lists[lsid];
    if (!list) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q = String(extra.search||"").toLowerCase().trim();
    // Use per-list default sort if client passes "sort" placeholder or omits
    const configured = (u.perListSort && u.perListSort[lsid]) || "date_asc";
    const sort = String(extra.sort||configured||"name_asc").toLowerCase();
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

app.get("/u/:uid/meta/:type/:id.json", async (req,res)=>{
  const u = await requireUser(req,res); if (!u) return;
  maybeBackgroundSync(u);
  try{
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

// -------- misc --------
app.get("/health", (_,res)=>res.status(200).send("ok"));
app.get("/debug", (req,res)=>{ if ((req.query.admin||"")!==ADMIN_PASSWORD) return res.status(403).send("Forbidden"); res.json({users:[...USERS.keys()], rev:MANIFEST_REV}); });

// ---------------- BOOT ----------------
app.listen(PORT, HOST, () => {
  console.log(`▶ Landing: ${HOST}:${PORT}/`);
  console.log(`Admin:    http://localhost:${PORT}/debug?admin=${ADMIN_PASSWORD}`);
});
