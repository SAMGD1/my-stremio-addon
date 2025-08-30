/* My Lists – IMDb → Stremio (multi-user, configurable)
 * v12.0.0
 */
"use strict";

const express = require("express");

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 7000);
const HOST = "0.0.0.0";

// Optional gate for your own service-wide admin actions (not needed by users)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";

// GH persistence (your private data repo)
const GITHUB_OWNER  = process.env.GITHUB_OWNER  || "";           // e.g. SAMGD1
const GITHUB_REPO   = process.env.GITHUB_REPO   || "my-stremio-addon-data";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || "";

// Sync cadence (minutes) – 0 disables timer; users can still press Sync in Admin
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

// default behavior for new users (can be changed in Admin)
const DEFAULT_UPGRADE_EPISODES = String(process.env.UPGRADE_EPISODES || "true").toLowerCase() !== "false";

// Fallback: allow seeding with a single-user setup (handy for your own account)
// If you pass IMDB_USER_URL via env and open "/", the landing page will be bypassed
const IMDB_USER_URL = process.env.IMDB_USER_URL || "";

// tolerant UA for IMDb
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};
const CINEMETA = "https://v3-cinemeta.strem.io";

// ---------- IN-MEMORY STATE (per-process cache) ----------
/** Map<uid, {
 *   uid, key, imdbUrl, prefs, lists, lastSync, manifestRev, lastManifestKey,
 *   caches:{ BEST:Map, FALLBACK:Map, EP2SER:Map }
 * }>
 */
const USERS = new Map();

// global sync ticker (only touches users loaded in memory)
const POLL_MS = 60 * 1000;

// ---------- UTIL ----------
const minutes = ms => Math.round(ms / 60000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (n=16) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => (b%36).toString(36)).join("");
const isImdb = v => /^tt\d{7,}$/i.test(String(v||""));
const isListId = v => /^ls\d{6,}$/i.test(String(v||""));

function absoluteBase(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return `${proto}://${host}`;
}

// ---------- GITHUB PERSISTENCE ----------
const GH_API = "https://api.github.com";
const GH_HEADERS = token => ({
  "Authorization": `Bearer ${token}`,
  "Accept": "application/vnd.github+json",
  "User-Agent": "stremio-addon-github-store"
});
async function ghReadFile(path){
  if (!GITHUB_TOKEN) return null;
  const url = `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const r = await fetch(url, { headers: GH_HEADERS(GITHUB_TOKEN) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub GET ${path} -> ${r.status}`);
  const j = await r.json();
  const content = Buffer.from(j.content || "", "base64").toString("utf8");
  return { content, sha: j.sha || null };
}
async function ghWriteFile(path, content, message){
  if (!GITHUB_TOKEN) return false;
  let sha = null;
  try {
    const got = await ghReadFile(path);
    sha = got && got.sha || null;
  } catch {}
  const url = `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const body = {
    message: message || `update ${path}`,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, { method:"PUT", headers: GH_HEADERS(GITHUB_TOKEN), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`GitHub PUT ${path} -> ${r.status}`);
  return true;
}
async function saveUser(u) {
  const shallow = {
    uid: u.uid, key: u.key, imdbUrl: u.imdbUrl,
    prefs: u.prefs, lists: u.lists,
    lastSync: u.lastSync || 0, manifestRev: u.manifestRev || 1, lastManifestKey: u.lastManifestKey || ""
  };
  await ghWriteFile(`users/${u.uid}.json`, JSON.stringify(shallow, null, 2), `save user ${u.uid}`);
}
async function loadUser(uid){
  // in-memory?
  if (USERS.has(uid)) return USERS.get(uid);
  // from GH
  const f = await ghReadFile(`users/${uid}.json`);
  let u;
  if (f && f.content) {
    const j = JSON.parse(f.content);
    u = {
      ...j,
      caches: { BEST: new Map(), FALLBACK: new Map(), EP2SER: new Map() }
    };
  } else {
    return null;
  }
  USERS.set(uid, u);
  return u;
}

// ---------- USER LIFECYCLE ----------
async function createUser(imdbUrl){
  const uid = rand(10);
  const key = rand(24);
  const u = {
    uid, key,
    imdbUrl: imdbUrl.trim(),
    prefs: {
      enabled: [],              // default: enable all when we first fetch
      order: [],
      defaultList: "",
      perListSort: {},          // lsid -> sort
      upgradeEpisodes: DEFAULT_UPGRADE_EPISODES,
      customOrder: {}           // lsid -> [tt...]
    },
    lists: {},                  // lsid -> { id, name, url, ids[] }
    lastSync: 0,
    manifestRev: 1,
    lastManifestKey: "",
    caches: { BEST:new Map(), FALLBACK:new Map(), EP2SER:new Map() }
  };
  await saveUser(u);
  USERS.set(uid, u);
  return u;
}

function manifestKeyFor(u){
  const enabled = new Set(u.prefs.enabled && u.prefs.enabled.length ? u.prefs.enabled : Object.keys(u.lists));
  const order = (u.prefs.order && u.prefs.order.length ? u.prefs.order : Object.keys(u.lists)).filter(id => enabled.has(id));
  const names = order.map(id => (u.lists[id]?.name || id)).join("|");
  const sorts = order.map(id => u.prefs.perListSort?.[id] || "name_asc").join(",");
  return order.join(",") + "#" + names + "#" + (u.prefs.defaultList || "") + "#" + sorts;
}

function requireKey(u, req, res){
  const q = new URL(req.originalUrl, absoluteBase(req)).searchParams;
  if (q.get("key") !== u.key) {
    res.status(403).send("Forbidden (missing or wrong key)");
    return false;
  }
  return true;
}

// ---------- IMDb scraping ----------
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
  ];
  for (const rx of tries) {
    const m = html.match(rx);
    if (m) return m[1].replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
  }
  const t = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (t) return t[1];
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

// ---------- Metadata ----------
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
async function episodeParentSeries(u, imdbId) {
  const EP2SER = u.caches.EP2SER;
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
async function getBestMeta(u, imdbId) {
  const BEST = u.caches.BEST, FALLBACK = u.caches.FALLBACK;
  if (BEST.has(imdbId)) return BEST.get(imdbId);

  let meta = await fetchCinemeta("series", imdbId);
  if (meta) { const rec = { kind: "series", meta }; BEST.set(imdbId, rec); return rec; }
  meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind: "movie", meta }; BEST.set(imdbId, rec); return rec; }

  // fallback
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
function cardFor(u, imdbId) {
  const BEST = u.caches.BEST, FALLBACK = u.caches.FALLBACK;
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

// ---------- SYNC ----------
async function fullSync(u, { rediscover = true, purge = false } = {}) {
  if (u._syncing) return;
  u._syncing = true;
  const started = Date.now();
  try {
    let discovered = [];
    if (u.imdbUrl && rediscover) {
      try { discovered = await discoverListsFromUser(u.imdbUrl); }
      catch (e) { console.warn(`[DISCOVER ${u.uid}] failed:`, e.message); }
    }

    // preserve existing if discovery failed
    const next = Object.create(null);
    const seen = new Set();
    for (const d of discovered) { next[d.id] = { id: d.id, name: d.name || d.id, url: d.url, ids: [] }; seen.add(d.id); }
    // keep previously known lists (unless purge)
    if (!purge) {
      for (const id of Object.keys(u.lists || {})) if (!seen.has(id)) next[id] = u.lists[id];
    }

    // enable default: all discovered if prefs empty
    if (!u.prefs.enabled || !u.prefs.enabled.length) u.prefs.enabled = Object.keys(next);

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
    if (u.prefs.upgradeEpisodes) {
      const up = new Set();
      for (const tt of idsToPreload) {
        const rec = await getBestMeta(u, tt);
        if (!rec.meta) {
          const s = await episodeParentSeries(u, tt);
          up.add(s && isImdb(s) ? s : tt);
        } else up.add(tt);
      }
      idsToPreload = Array.from(up);

      // remap per list (dedupe)
      for (const id of Object.keys(next)) {
        const remapped = []; const s = new Set();
        for (const tt of next[id].ids) {
          let fin = tt;
          const r = u.caches.BEST.get(tt);
          if (!r || !r.meta) { const z = await episodeParentSeries(u, tt); if (z) fin = z; }
          if (!s.has(fin)) { s.add(fin); remapped.push(fin); }
        }
        next[id].ids = remapped;
      }
    }

    await mapLimit(idsToPreload, 8, imdbId => getBestMeta(u, imdbId));

    u.lists = next;
    u.lastSync = Date.now();

    const key = manifestKeyFor(u);
    if (key !== u.lastManifestKey) {
      u.lastManifestKey = key;
      u.manifestRev = (u.manifestRev || 1) + 1;
      console.log(`[SYNC ${u.uid}] catalogs changed → manifest rev ${u.manifestRev}`);
    }
    console.log(`[SYNC ${u.uid}] ok – ${idsToPreload.length} ids across ${Object.keys(u.lists).length} lists in ${minutes(Date.now()-started)} min`);
    await saveUser(u);
  } catch (e) {
    console.error(`[SYNC ${u.uid}] failed:`, e);
  } finally {
    u._syncing = false;
  }
}

function maybeBackgroundSync(u){
  if (!IMDB_SYNC_MINUTES) return;
  const stale = Date.now() - (u.lastSync || 0) > IMDB_SYNC_MINUTES*60*1000;
  if (stale && !u._syncing) fullSync(u, { rediscover:true }).catch(()=>{});
}

setInterval(() => {
  if (!IMDB_SYNC_MINUTES) return;
  for (const u of USERS.values()) maybeBackgroundSync(u);
}, POLL_MS);

// ---------- SERVER ----------
const app = express();
app.use(express.json({ limit:"1mb" }));
app.use((_, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });

// base manifest data (shared)
const baseManifest = {
  id: "org.mylists.snapshot.multi",
  version: "12.0.0",
  name: "My Lists",
  description: "Your IMDb lists as catalogs (per-user, cached).",
  resources: ["catalog","meta"],
  types: ["my lists","movie","series"],
  idPrefixes: ["tt"]
};

// Landing (create user)
app.get("/", async (req,res)=>{
  // Optional fast-path for single-user env
  if (IMDB_USER_URL) {
    const base = absoluteBase(req);
    let u = [...USERS.values()].find(x => x.imdbUrl === IMDB_USER_URL);
    if (!u) u = await createUser(IMDB_USER_URL);
    const admin = `${base}/u/${u.uid}/admin?key=${u.key}`;
    const manifest = `${base}/u/${u.uid}/manifest.json`;
    res.redirect(admin);
    return;
  }

  const base = absoluteBase(req);
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>My Lists – Setup</title>
<style>
:root{--bg:#160a2d;--fg:#f8f7ff;--mute:#c3badd;--p:#8e79ff;--p2:#ff89d0;}
body{margin:0;font-family:system-ui,Segoe UI,Roboto,Arial;background:
radial-gradient(1200px 600px at 10% -10%, #2a175a, transparent),
radial-gradient(900px 500px at 100% 0%, #3a1767, transparent),
linear-gradient(180deg,#120726,#0e0920 60%, #0a0818);color:var(--fg);}
.wrap{max-width:900px;margin:48px auto;padding:0 16px}
.card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:20px;box-shadow:0 8px 30px rgba(0,0,0,.35);backdrop-filter: blur(4px)}
h1{font-size:28px;margin-bottom:6px} p{color:var(--mute)}
input[type=text]{width:100%;padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:var(--fg);outline:0}
button{padding:10px 16px;border:0;border-radius:10px;background:linear-gradient(135deg,var(--p),var(--p2));color:#fff;cursor:pointer}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
.badge{display:inline-block;padding:6px 10px;border-radius:999px;background:rgba(255,255,255,.08)}
.code{font-family:ui-monospace,Menlo,Consolas,monospace}
a{color:#b6a8ff}
</style></head>
<body><div class="wrap">
  <h1>My Lists – Create your personal addon</h1>
  <p>Paste your IMDb <b>lists</b> page URL (e.g. <span class="code">https://www.imdb.com/user/urXXXXXXX/lists/</span>) and click Create.</p>
  <div class="card">
    <input id="imdb" type="text" placeholder="https://www.imdb.com/user/ur.../lists/"/>
    <div class="row">
      <button id="go">Create</button>
      <span id="msg" class="badge"></span>
    </div>
    <div id="out" style="margin-top:14px;display:none">
      <p><b>Admin:</b> <a id="admin" href="#" target="_blank"></a></p>
      <p><b>Manifest:</b> <a id="man" href="#" target="_blank"></a></p>
      <p><button id="inst">Open in Stremio</button></p>
    </div>
  </div>
  <p style="margin-top:18px">After installing the addon in Stremio, click the <b>⚙ Configure</b> button to open your Admin page anytime.</p>
</div>
<script>
const go = document.getElementById('go');
const imdb = document.getElementById('imdb');
const msg = document.getElementById('msg');
const out = document.getElementById('out');
const admin = document.getElementById('admin');
const man = document.getElementById('man');
const inst = document.getElementById('inst');

go.onclick = async ()=>{
  msg.textContent = "Creating…";
  out.style.display = "none";
  try{
    const r = await fetch('/api/create', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ imdbUrl: imdb.value }) });
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    msg.textContent = "Done!";
    out.style.display = "";
    admin.textContent = j.adminUrl; admin.href = j.adminUrl;
    man.textContent = j.manifestUrl; man.href = j.manifestUrl;
    inst.onclick = ()=> location.href = j.manifestUrl; // safe default
  }catch(e){
    msg.textContent = "Error: "+e.message;
  }
};
</script>
</body></html>`);
});

// create user (public)
app.post("/api/create", async (req,res)=>{
  try{
    const imdbUrl = String(req.body?.imdbUrl || "").trim();
    if (!/^https?:\/\/(www\.)?imdb\.com\/(user\/ur\d+\/lists\/|list\/ls\d+\/?)$/i.test(imdbUrl))
      return res.status(400).send("Provide a valid IMDb lists URL");
    const u = await createUser(imdbUrl);
    // kick background sync (don’t block)
    fullSync(u, { rediscover:true }).catch(()=>{});
    const base = absoluteBase(req);
    res.json({
      uid: u.uid,
      key: u.key,
      adminUrl: `${base}/u/${u.uid}/admin?key=${u.key}`,
      manifestUrl: `${base}/u/${u.uid}/manifest.json`
    });
  }catch(e){ res.status(500).send(String(e.message||e)); }
});

// ---------- USER ROUTES (per-uid base) ----------

// manifest with Configure gear
app.get("/u/:uid/manifest.json", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Unknown user");
  maybeBackgroundSync(u);

  const base = absoluteBase(req);
  const configPage = `${base}/u/${u.uid}/admin?key=${u.key}`;

  res.json({
    ...baseManifest,
    version: `${baseManifest.version}-${u.manifestRev || 1}`,
    catalogs: catalogsForUser(u),
    behaviorHints: {
      configurable: true,
      configurationPage: configPage
    }
  });
});

function catalogsForUser(u){
  const enabled = new Set(u.prefs.enabled && u.prefs.enabled.length ? u.prefs.enabled : Object.keys(u.lists));
  const order = (u.prefs.order && u.prefs.order.length ? u.prefs.order : Object.keys(u.lists))
    .filter(id => enabled.has(id));
  return order.map(lsid => ({
    type: "My lists",
    id: `list:${lsid}`,
    name: `🗂 ${u.lists[lsid]?.name || lsid}`,
    extraSupported: ["search","skip","limit","sort"],
    extra: [
      { name:"search" }, { name:"skip" }, { name:"limit" },
      { name:"sort", options:["custom","date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"] }
    ],
    posterShape: "poster"
  }));
}

// catalog
app.get("/u/:uid/catalog/:type/:id/:extra?.json", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.json({ metas: [] });
  maybeBackgroundSync(u);

  const { id } = req.params;
  if (!id || !id.startsWith("list:")) return res.json({ metas: [] });
  const lsid = id.slice(5);
  const list = u.lists[lsid];
  if (!list) return res.json({ metas: [] });

  const p = new URLSearchParams(req.params.extra || "");
  for (const [k,v] of new URLSearchParams(req.url.split("?")[1]||"")) if (!p.has(k)) p.set(k,v);

  const q     = String(p.get("search") || "").toLowerCase().trim();
  const skip  = Math.max(0, Number(p.get("skip") || 0));
  const limit = Math.min(Number(p.get("limit") || 100), 200);

  let sort = String(p.get("sort") || "").toLowerCase();
  if (!sort || sort === "default") sort = (u.prefs.perListSort && u.prefs.perListSort[lsid]) || "name_asc";

  let metas = (list.ids || []).map(tt => cardFor(u, tt));
  if (q) metas = metas.filter(m => (m.name||"").toLowerCase().includes(q) || (m.id||"").toLowerCase().includes(q) || (m.description||"").toLowerCase().includes(q));

  if (sort === "custom" && Array.isArray(u.prefs.customOrder?.[lsid]) && u.prefs.customOrder[lsid].length) {
    const order = new Map(u.prefs.customOrder[lsid].map((tt,i)=>[tt,i]));
    metas.sort((a,b)=>{
      const ia = order.has(a.id) ? order.get(a.id) : 1e9;
      const ib = order.has(b.id) ? order.get(b.id) : 1e9;
      return ia - ib || (a.name||"").localeCompare(b.name||"");
    });
  } else {
    metas = stableSort(metas, sort);
  }

  res.json({ metas: metas.slice(skip, skip+limit) });
});

// meta
app.get("/u/:uid/meta/:type/:id.json", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.json({ meta:{ id:req.params.id, type:"movie", name:"Unknown item" } });
  maybeBackgroundSync(u);

  const imdbId = req.params.id;
  if (!isImdb(imdbId)) return res.json({ meta:{ id: imdbId, type:"movie", name:"Unknown item" } });

  let rec = u.caches.BEST.get(imdbId);
  if (!rec) rec = await getBestMeta(u, imdbId);
  if (!rec || !rec.meta) {
    const fb = u.caches.FALLBACK.get(imdbId) || {};
    return res.json({ meta: { id: imdbId, type: rec?.kind || fb.type || "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
  }
  res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
});

// ---------- Admin (per-user) ----------
app.get("/u/:uid/admin", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Unknown user");
  if (!requireKey(u, req, res)) return;

  const base = absoluteBase(req);
  const manifestUrl = `${base}/u/${u.uid}/manifest.json`;
  let discovered = [];
  try { if (u.imdbUrl) discovered = await discoverListsFromUser(u.imdbUrl); } catch {}

  const rows = Object.keys(u.lists).map(id=>{
    const L = u.lists[id]; const count=(L.ids||[]).length;
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
th,td{padding:8px;border-bottom:1px solid #eee}
tbody tr[draggable="true"] { cursor: grab; }
tbody tr.dragging { opacity: .5; }
.grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(180px,1fr));gap:12px}
.item{border:1px solid #ddd;border-radius:10px;padding:8px;display:flex;gap:8px;align-items:center;background:#fafafa}
.item img{width:38px;height:56px;border-radius:6px;object-fit:cover;background:#eee}
.kv{font-size:12px;color:#666}
</style></head><body>
<h1>My Lists – Admin</h1>

<div class="card">
  <h3>Current Snapshot</h3>
  <ul>${rows}</ul>
  <p><small>Last sync: ${u.lastSync ? new Date(u.lastSync).toLocaleString() + " (" + minutes(Date.now()-u.lastSync) + " min ago)" : "never"}</small></p>
  <form method="POST" action="/u/${u.uid}/api/sync?key=${u.key}" style="display:inline"><button>Sync IMDb Lists Now</button></form>
  <form method="POST" action="/u/${u.uid}/api/purge?key=${u.key}" style="display:inline;margin-left:8px"><button style="background:#b34343">Purge & Sync</button></form>
  <span class="badge">Auto-sync every ${IMDB_SYNC_MINUTES} min${IMDB_SYNC_MINUTES ? "" : " (disabled)"}</span>
</div>

<div class="card">
  <h3>Customize (enable/disable, order, defaults)</h3>
  <div id="prefs"></div>
</div>

<div class="card">
  <h3>Discovered at <span class="code">${u.imdbUrl || "(no IMDb URL set)"}</span></h3>
  <ul>${disc}</ul>
</div>

<div class="card">
  <h3>Manifest URL</h3>
  <p class="code">${manifestUrl}</p>
  <p><small>Version bumps automatically when catalogs change. Manifest rev: ${u.manifestRev||1}</small></p>
</div>

<script>
async function getPrefs(){ const r = await fetch('/u/${u.uid}/api/prefs?key=${u.key}'); return r.json(); }
async function getLists(){ const r = await fetch('/u/${u.uid}/api/lists?key=${u.key}'); return r.json(); }

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
// drag rows in tbody
function attachDnD(tbody) {
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
    e.preventDefault(); if (!dragSrc) return;
    const over = e.target.closest('tr[data-lsid]'); if (!over || over === dragSrc) return;
    const rect = over.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    over.parentNode.insertBefore(dragSrc, before ? over : over.nextSibling);
  });
  tbody.addEventListener('drop', (e) => { e.preventDefault(); });
}

async function render() {
  const prefs = await getPrefs();
  const lists = await getLists();
  const container = document.getElementById('prefs'); container.innerHTML = "";

  const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));
  const order = (prefs.order && prefs.order.length
    ? prefs.order.filter(id => lists[id])
    : Object.keys(lists));

  const table = el('table');
  const thead = el('thead', {}, [el('tr',{},[
    el('th',{text:'Enabled'}), el('th',{text:'List (lsid)'}), el('th',{text:'Items'}),
    el('th',{text:'Default sort'})
  ])]); table.appendChild(thead);
  const tbody = el('tbody');

  function makeRow(lsid) {
    const L = lists[lsid]; const tr = el('tr', {'data-lsid': lsid, draggable:'true'});
    const cb = el('input', {type:'checkbox'}); cb.checked = enabledSet.has(lsid);
    cb.addEventListener('change', ()=>{ if (cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); });

    const nameCell = el('td',{}); nameCell.appendChild(el('div',{text:(L.name||lsid)}));
    nameCell.appendChild(el('small',{text:lsid}));

    const count = el('td',{text:String((L.ids||[]).length)});

    const sortSel = el('select');
    const opts = ["custom","date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"];
    const def = (prefs.perListSort && prefs.perListSort[lsid]) || "name_asc";
    opts.forEach(o=> sortSel.appendChild(el('option',{value:o,text:o, ...(o===def?{selected:""}:{})})));
    sortSel.addEventListener('change', ()=>{ prefs.perListSort = prefs.perListSort || {}; prefs.perListSort[lsid] = sortSel.value; });

    tr.appendChild(el('td',{},[cb]));
    tr.appendChild(nameCell);
    tr.appendChild(count);
    tr.appendChild(el('td',{},[sortSel]));
    return tr;
  }
  order.forEach(lsid => tbody.appendChild(makeRow(lsid)));
  attachDnD(tbody); table.appendChild(tbody);

  container.appendChild(el('div', {html:'<b>Default list:</b> '}));
  const defSel = el('select');
  order.forEach(lsid => defSel.appendChild(el('option',{value:lsid,text:(lists[lsid].name||lsid), ...(lsid===prefs.defaultList?{selected:""}:{})})));
  container.appendChild(defSel);
  container.appendChild(el('div', {style:'margin-top:8px'}));
  const epCb = el('input',{type:'checkbox'}); epCb.checked = !!prefs.upgradeEpisodes;
  container.appendChild(epCb); container.appendChild(el('span',{text:' Upgrade episodes to parent series'}));
  container.appendChild(el('div',{style:'margin-top:10px'})); container.appendChild(table);

  const saveBtn = el('button',{text:'Save'}); container.appendChild(el('div',{class:'row'},[saveBtn, el('span',{id:'saveMsg',class:'badge'})]));
  const saveMsg = document.getElementById('saveMsg');

  saveBtn.onclick = async ()=>{
    const newOrder = Array.from(tbody.querySelectorAll('tr[data-lsid]')).map(tr => tr.getAttribute('data-lsid'));
    const enabled = Array.from(enabledSet);
    const body = { enabled, order: newOrder, defaultList: defSel.value, perListSort: prefs.perListSort || {}, upgradeEpisodes: epCb.checked };
    saveMsg.textContent = "Saving…";
    const r = await fetch('/u/${u.uid}/api/prefs?key=${u.key}', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const t = await r.text(); saveMsg.textContent = t || "Saved.";
    setTimeout(()=>{ saveMsg.textContent = ""; location.reload(); }, 800);
  };
}
render();
</script>
</body></html>`);
});

// Admin APIs
app.get("/u/:uid/api/prefs", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Unknown user");
  if (!requireKey(u, req, res)) return;
  res.json(u.prefs || {});
});
app.post("/u/:uid/api/prefs", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Unknown user");
  if (!requireKey(u, req, res)) return;
  u.prefs = Object.assign({}, u.prefs || {}, req.body || {});
  // bump manifest if order/enabled/defaultList/sorts changed
  const key = manifestKeyFor(u);
  if (key !== u.lastManifestKey) { u.lastManifestKey = key; u.manifestRev = (u.manifestRev||1)+1; }
  await saveUser(u);
  res.send(`Saved. Manifest rev ${u.manifestRev}`);
});
app.get("/u/:uid/api/lists", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Unknown user");
  if (!requireKey(u, req, res)) return;
  res.json(u.lists || {});
});
app.post("/u/:uid/api/sync", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Unknown user");
  if (!requireKey(u, req, res)) return;
  try{
    await fullSync(u, { rediscover:true });
    res.status(200).send(`Synced at ${new Date().toISOString()}. <a href="/u/${u.uid}/admin?key=${u.key}">Back</a>`);
  }catch(e){ res.status(500).send(String(e)); }
});
app.post("/u/:uid/api/purge", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Unknown user");
  if (!requireKey(u, req, res)) return;
  try{
    await fullSync(u, { rediscover:true, purge:true });
    res.status(200).send(`Purged & synced at ${new Date().toISOString()}. <a href="/u/${u.uid}/admin?key=${u.key}">Back</a>`);
  }catch(e){ res.status(500).send(String(e)); }
});

// tiny debug helper
app.get("/u/:uid/api/debug-imdb", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Unknown user");
  if (!requireKey(u, req, res)) return;
  try{
    const url = u.imdbUrl;
    if (!url) return res.type("text").send("No IMDb URL configured.");
    const html = await fetchText(withParam(url,"_","dbg"));
    res.type("text").send(html.slice(0,2000));
  }catch(e){ res.type("text").status(500).send("Fetch failed: "+e.message); }
});

// ---------- BOOT ----------
app.listen(PORT, HOST, () => {
  console.log(`My Lists running on http://localhost:${PORT}`);
  if (IMDB_USER_URL) {
    (async ()=>{
      let u = [...USERS.values()].find(x => x.imdbUrl === IMDB_USER_URL);
      if (!u) u = await createUser(IMDB_USER_URL);
      fullSync(u, { rediscover:true }).catch(()=>{});
    })();
  }
});
