/*  My Lists – IMDb → Stremio (multi-user)
 *  v12.0.0
 */
"use strict";

const express = require("express");
const fs = require("fs/promises");

// ---------- ENV ----------
const PORT  = Number(process.env.PORT || 10000);
const HOST  = "0.0.0.0";

const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60)); // set to 2 for fast tests

// Optional GitHub persistence (recommended)
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || "";
const GITHUB_OWNER  = process.env.GITHUB_OWNER  || "";
const GITHUB_REPO   = process.env.GITHUB_REPO   || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GH_ENABLED    = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

// Optional single-user bootstrap (leave blank for public landing page)
const BOOT_IMDB_USER_URL = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/

// Local fallback store (also used when GH is off)
const USERS_DIR_LOCAL = "data/users";

// ---------- CONSTANTS ----------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/12.0";
const GH_API = "https://api.github.com";
const CINEMETA = "https://v3-cinemeta.strem.io";
const REQ_HEADERS_HTML = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};

// ---------- HELPERS ----------
const minutes = ms => Math.round(ms/60000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const withParam = (u,k,v) => { const x = new URL(u); x.searchParams.set(k,v); return x.toString(); };
const isImdb  = v => /^tt\d{7,}$/i.test(String(v||""));
const isList  = v => /^ls\d{6,}$/i.test(String(v||""));
const pick    = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k]]));

async function fetchText(url) {
  const r = await fetch(url, { headers: REQ_HEADERS_HTML, redirect: "follow" });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept":"application/json" }, redirect:"follow" });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

// ---------- GitHub I/O (safe) ----------
const GH_HEADERS = tok => ({
  "Authorization": `Bearer ${tok}`,
  "Accept": "application/vnd.github+json",
  "Content-Type": "application/json",
  "User-Agent": UA
});

async function ghRead(path) {
  const url = `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const r = await fetch(url, { headers: GH_HEADERS(GITHUB_TOKEN) });
  if (!r.ok) return null;
  return r.json();
}
async function ghReadJson(path) {
  const data = await ghRead(path);
  if (!data || !data.content) return null;
  const txt = Buffer.from(data.content, "base64").toString("utf8");
  const json = JSON.parse(txt);
  return { json, sha: data.sha || null };
}
async function ghWriteJson(path, json, message) {
  // retry once on 409/422 by refreshing sha
  const put = async (sha) => {
    const url = `${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
    const body = {
      message: message || `update ${path}`,
      content: Buffer.from(JSON.stringify(json, null, 2), "utf8").toString("base64"),
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {})
    };
    return fetch(url, { method:"PUT", headers: GH_HEADERS(GITHUB_TOKEN), body: JSON.stringify(body) });
  };

  let sha = null;
  const existing = await ghRead(path);
  if (existing && existing.sha) sha = existing.sha;

  let r = await put(sha);
  if (r.ok) return true;

  if (r.status === 409 || r.status === 422) {
    const again = await ghRead(path);
    const freshSha = again && again.sha ? again.sha : null;
    r = await put(freshSha);
    if (r.ok) return true;
  }
  const txt = await r.text().catch(()=> "");
  throw new Error(`GitHub PUT ${path} -> ${r.status}: ${txt}`);
}

// ---------- PERSISTENCE ----------
async function localReadUser(uid) {
  try {
    const p = `${USERS_DIR_LOCAL}/${uid}.json`;
    const txt = await fs.readFile(p, "utf8");
    return JSON.parse(txt);
  } catch { return null; }
}
async function localWriteUser(uid, json) {
  try {
    await fs.mkdir(USERS_DIR_LOCAL, { recursive: true });
    await fs.writeFile(`${USERS_DIR_LOCAL}/${uid}.json`, JSON.stringify(json, null, 2), "utf8");
    return true;
  } catch { return false; }
}

// Returns a lightweight JSON object; caller rehydrates Maps
async function storeUser(uid, json) {
  if (GH_ENABLED) {
    await ghWriteJson(`users/${uid}.json`, json, `save users/${uid}.json`);
  } else {
    await localWriteUser(uid, json);
  }
}
async function loadUserJson(uid) {
  if (GH_ENABLED) {
    const got = await ghReadJson(`users/${uid}.json`);
    if (got && got.json) return got.json;
  } else {
    const j = await localReadUser(uid);
    if (j) return j;
  }
  return null;
}

// optional helper: find an existing user by imdbUrl (requires list directory on GH)
async function findUserByImdb(imdbUrl) {
  if (!GH_ENABLED) return null;
  try {
    const r = await fetch(`${GH_API}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent("users")}?ref=${encodeURIComponent(GITHUB_BRANCH)}`, { headers: GH_HEADERS(GITHUB_TOKEN) });
    if (!r.ok) return null;
    const arr = await r.json();
    for (const it of arr) {
      if (it.type === "file" && it.name.endsWith(".json")) {
        const got = await ghReadJson(`users/${it.name}`);
        if (got?.json?.imdbUrl === imdbUrl) {
          const uid = it.name.replace(/\.json$/,"");
          return { uid, json: got.json };
        }
      }
    }
  } catch {}
  return null;
}

// ---------- SCRAPER / METADATA ----------
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(withParam(userListsUrl, "_", Date.now()));

  const ids = new Set();
  let m;
  const re = /href=['"](?:https?:\/\/(?:www\.)?imdb\.com)?\/list\/(ls\d{6,})\/['"]/gi;
  while ((m = re.exec(html))) ids.add(m[1]);
  if (!ids.size) { // fallback scan
    const re2 = /\/list\/(ls\d{6,})\//gi;
    while ((m = re2.exec(html))) ids.add(m[1]);
  }

  const arr = Array.from(ids).map(id => ({ id, url: `https://www.imdb.com/list/${id}/` }));
  await Promise.all(arr.map(async L => { try { L.name = await fetchListName(L.url); } catch { L.name = L.id; } }));
  return arr;
}
async function fetchListName(listUrl) {
  const html = await fetchText(withParam(listUrl, "_", Date.now()));
  const one = html.match(/<h1[^>]+data-testid=["']list-header-title["'][^>]*>(.*?)<\/h1>/i)
         || html.match(/<h1[^>]*class=["'][^"']*header[^"']*["'][^>]*>(.*?)<\/h1>/i);
  if (one) return one[1].replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
  const t = html.match(/<title>(.*?)<\/title>/i);
  return t ? t[1].replace(/\s+\-\s*IMDb.*$/i, "").trim() : listUrl;
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
async function fetchImdbListIdsAllPages(listUrl, maxPages=80) {
  const modes = ["detail","grid","compact"];
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
      await sleep(60);
    }
    if (ids.length) break;
  }
  return ids;
}

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
  try {
    const ld = await imdbJsonLd(imdbId);
    let node = Array.isArray(ld && ld["@graph"]) ? ld["@graph"].find(x => /TVEpisode/i.test(x["@type"])) : ld;
    const part = node && (node.partOfSeries || node.partOfTVSeries || (node.partOfSeason && node.partOfSeason.partOfSeries));
    const url = typeof part === "string" ? part : (part && (part.url || part.sameAs || part["@id"]));
    if (url) { const m = String(url).match(/tt\d{7,}/i); if (m) return m[0]; }
  } catch {}
  return null;
}

function toTs(d,y){ if(d){const t=Date.parse(d); if(!Number.isNaN(t)) return t;} if(y){const t=Date.parse(`${y}-01-01`); if(!Number.isNaN(t)) return t;} return null; }
function cmpNullBottom(a,b){ return (a==null && b==null)?0 : (a==null?1 : (b==null?-1 : (a<b?-1:(a>b?1:0)))); }

function stableSort(items, sortKey) {
  const s = String(sortKey || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const key = s.split("_")[0];
  return items.map((m,i)=>({m,i})).sort((A,B)=>{
    const a=A.m, b=B.m; let c=0;
    if (key==="date")    c = cmpNullBottom(toTs(a.releaseDate,a.year), toTs(b.releaseDate,b.year));
    else if (key==="rating")  c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
    else if (key==="runtime") c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
    else c = (a.name||"").localeCompare(b.name||"");
    if (c===0){ c=(a.name||"").localeCompare(b.name||""); if(c===0) c=(a.id||"").localeCompare(b.id||""); if(c===0) c=A.i-B.i; }
    return c*dir;
  }).map(x=>x.m);
}
function applyCustomOrder(metas, orderArr) {
  if (!orderArr || !orderArr.length) return metas.slice();
  const pos = new Map(orderArr.map((id,i)=>[id,i]));
  return metas.slice().sort((a,b)=>{
    const pa = pos.has(a.id) ? pos.get(a.id) : 1e9;
    const pb = pos.has(b.id) ? pos.get(b.id) : 1e9;
    if (pa !== pb) return pa - pb;
    return (a.name||"").localeCompare(b.name||"");
  });
}

// ---------- USER RUNTIME ----------
const USERS = new Map();        // uid -> runtime user object
const TIMERS = new Map();       // uid -> timeout id

function newUserRuntime(imdbUrl) {
  return {
    uid: (Math.random().toString(36).slice(2,10)),
    key: (Math.random().toString(36).slice(2,8) + Math.random().toString(36).slice(2,6)),
    imdbUrl,
    createdAt: Date.now(),
    lastSyncAt: 0,
    rev: 1,
    lists: Object.create(null), // { lsid: { id, name, url, ids:[] } }
    prefs: {
      enabled: [],
      order: [],
      defaultList: "",
      perListSort: {},      // { lsid: 'date_asc' | ... | 'custom' }
      customOrder: {},      // { lsid: [ 'tt..', ... ] }
      upgradeEpisodes: true
    },
    cache: { BEST:new Map(), FALL:new Map(), EP2SER:new Map(), CARD:new Map() }
  };
}

function cardFor(u, imdbId) {
  const rec = u.cache.BEST.get(imdbId) || { kind:null, meta:null };
  const m = rec.meta || {};
  const fb = u.cache.FALL.get(imdbId) || {};
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

async function getBestMeta(u, imdbId) {
  if (u.cache.BEST.has(imdbId)) return u.cache.BEST.get(imdbId);
  let meta = await fetchCinemeta("series", imdbId);
  if (meta) { const rec = { kind:"series", meta }; u.cache.BEST.set(imdbId, rec); return rec; }
  meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind:"movie", meta }; u.cache.BEST.set(imdbId, rec); return rec; }
  // fallback
  const ld = await imdbJsonLd(imdbId);
  let name, poster, released, year, type = "movie";
  try {
    const node = Array.isArray(ld && ld["@graph"]) ? ld["@graph"].find(x => x["@id"]?.includes(`/title/${imdbId}`)) || ld["@graph"][0] : ld;
    name = node?.name || node?.headline || ld?.name;
    poster = typeof node?.image === "string" ? node.image : (node?.image?.url || ld?.image);
    released = node?.datePublished || node?.startDate || node?.releaseDate || undefined;
    year = released ? Number(String(released).slice(0,4)) : undefined;
    const t = Array.isArray(node?.["@type"]) ? node["@type"].join(",") : (node?.["@type"] || "");
    if (/Series/i.test(t)) type = "series";
    else if (/TVEpisode/i.test(t)) type = "episode";
  } catch {}
  const rec = { kind: type === "series" ? "series" : "movie", meta: name ? { name, poster, released, year } : null };
  u.cache.BEST.set(imdbId, rec);
  if (name || poster) u.cache.FALL.set(imdbId, { name, poster, releaseDate: released, year, type: rec.kind });
  return rec;
}

// ---------- SYNC ----------
async function syncUser(u, { rediscover=true } = {}) {
  const started = Date.now();

  try {
    let discovered = [];
    if (u.imdbUrl && rediscover) {
      try { discovered = await discoverListsFromUser(u.imdbUrl); }
      catch (e) { console.warn(`[${u.uid}] discover failed:`, e.message); }
    }

    // keep old lists if discovery is temporarily empty
    const next = Object.create(null);
    const seen = new Set();
    for (const d of discovered) { next[d.id] = { id:d.id, name:d.name||d.id, url:d.url, ids:[] }; seen.add(d.id); }
    for (const id of Object.keys(u.lists)) if (!seen.has(id)) next[id] = u.lists[id];

    // pull items
    const uniques = new Set();
    for (const id of Object.keys(next)) {
      const url = next[id].url || `https://www.imdb.com/list/${id}/`;
      let ids = [];
      try { ids = await fetchImdbListIdsAllPages(url); } catch {}
      next[id].ids = ids;
      ids.forEach(tt => uniques.add(tt));
      await sleep(50);
    }

    // episode → series (optional)
    let idsToPreload = Array.from(uniques);
    if (u.prefs.upgradeEpisodes) {
      const up = new Set();
      for (const tt of idsToPreload) {
        const rec = await getBestMeta(u, tt);
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
          const r = u.cache.BEST.get(tt);
          if (!r || !r.meta) { const z = await episodeParentSeries(tt); if (z) fin = z; }
          if (!s.has(fin)) { s.add(fin); remapped.push(fin); }
        }
        next[id].ids = remapped;
      }
    }

    // preload cards
    for (const tt of idsToPreload) { await getBestMeta(u, tt); u.cache.CARD.set(tt, cardFor(u, tt)); }

    u.lists = next;
    u.lastSyncAt = Date.now();

    // drop stale custom orders for deleted lists
    const valid = new Set(Object.keys(u.lists));
    if (u.prefs.customOrder) for (const k of Object.keys(u.prefs.customOrder)) if (!valid.has(k)) delete u.prefs.customOrder[k];

    // bump rev if catalogs changed
    const enabled = u.prefs.enabled?.length ? u.prefs.enabled : Object.keys(u.lists);
    const keyNow = enabled.join(",") + "#" + (u.prefs.defaultList||"") + "#" + JSON.stringify(u.prefs.perListSort||{}) + "#" + Object.keys(u.prefs.customOrder||{}).length;
    u._manifestKey = keyNow;
    if (u._manifestKey !== u._manifestKey_last) { u._manifestKey_last = keyNow; u.rev++; }

    // persist
    await storeUser(u.uid, toUserJson(u));

    console.log(`[${u.uid}] synced ${idsToPreload.length} ids / ${Object.keys(u.lists).length} lists in ${minutes(Date.now()-started)} min`);
  } catch (e) {
    console.error(`[${u.uid}] sync failed:`, e);
  }
}
function scheduleNextSync(u) {
  if (TIMERS.has(u.uid)) clearTimeout(TIMERS.get(u.uid));
  if (IMDB_SYNC_MINUTES <= 0) return;
  const t = setTimeout(() => syncUser(u, { rediscover:true }).then(()=>scheduleNextSync(u)), IMDB_SYNC_MINUTES*60*1000);
  TIMERS.set(u.uid, t);
}
function maybeBackgroundSync(u) {
  if (IMDB_SYNC_MINUTES <= 0) return;
  const stale = Date.now() - (u.lastSyncAt||0) > IMDB_SYNC_MINUTES*60*1000;
  if (stale) syncUser(u, { rediscover:true }).then(()=>scheduleNextSync(u));
}

// ---------- USER LOAD / SAVE ----------
function toUserJson(u) {
  // convert Maps to plain objects for persistence
  const BEST = Object.fromEntries(u.cache.BEST);
  const FALL = Object.fromEntries(u.cache.FALL);
  const EP2  = Object.fromEntries(u.cache.EP2SER);
  const CARD = Object.fromEntries(u.cache.CARD);
  return {
    uid: u.uid, key: u.key, imdbUrl: u.imdbUrl, createdAt: u.createdAt, lastSyncAt: u.lastSyncAt, rev: u.rev,
    lists: u.lists, prefs: u.prefs, cache: { BEST, FALL, EP2, CARD }
  };
}
function fromUserJson(j) {
  const u = {
    uid: j.uid, key: j.key, imdbUrl: j.imdbUrl, createdAt: j.createdAt, lastSyncAt: j.lastSyncAt||0, rev: j.rev||1,
    lists: j.lists || Object.create(null),
    prefs: j.prefs || { enabled:[], order:[], defaultList:"", perListSort:{}, customOrder:{}, upgradeEpisodes:true },
    cache: { BEST:new Map(), FALL:new Map(), EP2SER:new Map(), CARD:new Map() }
  };
  if (j.cache?.BEST) for (const [k,v] of Object.entries(j.cache.BEST)) u.cache.BEST.set(k,v);
  if (j.cache?.FALL) for (const [k,v] of Object.entries(j.cache.FALL)) u.cache.FALL.set(k,v);
  if (j.cache?.EP2)  for (const [k,v] of Object.entries(j.cache.EP2))  u.cache.EP2SER.set(k,v);
  if (j.cache?.CARD) for (const [k,v] of Object.entries(j.cache.CARD)) u.cache.CARD.set(k,v);
  return u;
}
async function loadUser(uid) {
  if (USERS.has(uid)) return USERS.get(uid);
  const j = await loadUserJson(uid);
  if (!j) return null;
  const u = fromUserJson(j);
  USERS.set(uid, u);
  return u;
}
async function createUser(imdbUrl) {
  const u = newUserRuntime(imdbUrl);
  USERS.set(u.uid, u);
  await storeUser(u.uid, toUserJson(u));
  // kick off first sync in background
  syncUser(u, { rediscover:true }).then(()=>scheduleNextSync(u));
  return u;
}

// ---------- SERVER ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

// Landing page (create user)
app.get("/", async (req,res)=>{
  // If BOOT_IMDB_USER_URL is set, create/reuse and redirect to admin
  if (BOOT_IMDB_USER_URL) {
    let u;
    const found = await findUserByImdb(BOOT_IMDB_USER_URL);
    if (found) u = fromUserJson(found.json);
    else u = await createUser(BOOT_IMDB_USER_URL);
    const adminUrl = `/u/${u.uid}/admin?key=${u.key}`;
    res.redirect(adminUrl);
    return;
  }

  res.type("html").send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Create</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,Arial;display:grid;place-items:center;min-height:100vh;margin:0;background:linear-gradient(135deg,#1f1144,#0c0f2b);color:#fff}
  .box{width:min(720px,92%);background:rgba(255,255,255,.06);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:24px}
  h1{margin:0 0 12px;font-weight:700}
  input[type=url]{width:100%;padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:#0f1032;color:#fff}
  button{margin-top:12px;padding:12px 18px;border:0;border-radius:10px;background:#7c4dff;color:#fff;cursor:pointer}
  small{color:#cfd2ff}
</style></head><body>
<div class="box">
  <h1>My Lists – IMDb ➜ Stremio</h1>
  <p>Paste your IMDb <b>Lists</b> URL (e.g. <code>https://www.imdb.com/user/urXXXX/lists/</code>) and click Create.</p>
  <form method="POST" action="/create">
    <input type="url" name="imdb" placeholder="https://www.imdb.com/user/urXXXX/lists/" required />
    <button>Create my addon</button>
  </form>
  <p><small>After creation you’ll get your personal Admin & Manifest links. You can add extra lists in Admin later.</small></p>
</div>
</body></html>`);
});

app.post("/create", express.urlencoded({ extended: true }), async (req,res)=>{
  try {
    const url = String(req.body.imdb || "").trim();
    if (!/^https?:\/\/(www\.)?imdb\.com\/user\/[^/]+\/lists\/?$/i.test(url)) {
      res.status(400).type("text").send("Invalid IMDb Lists URL.");
      return;
    }
    // try reuse if exists
    let u;
    const found = await findUserByImdb(url);
    if (found) {
      u = fromUserJson(found.json);
      USERS.set(u.uid, u);
    } else {
      u = await createUser(url);
    }
    res.type("html").send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Created</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px}
  code{background:#f6f6f6;border-radius:6px;padding:4px 6px}
  a.button{display:inline-block;margin-top:8px;padding:10px 14px;border-radius:10px;background:#2d6cdf;color:#fff;text-decoration:none}
</style></head><body>
  <h2>All set 🎉</h2>
  <p><b>Admin:</b> <code>/u/${u.uid}/admin?key=${u.key}</code></p>
  <p><b>Manifest:</b> <code>/u/${u.uid}/manifest.json</code></p>
  <p><a class="button" href="/u/${u.uid}/admin?key=${u.key}">Open Admin</a></p>
</body></html>`);
  } catch (e) {
    console.error("create error:", e);
    res.status(500).send("Failed to create.");
  }
});

// ---------- USER ROUTES ----------
function requireUserKey(u, req, res) {
  const key = String(req.query.key || "");
  if (key !== u.key) { res.status(403).send("Forbidden"); return false; }
  return true;
}

function manifestForUser(u, baseUrl) {
  const catalogs = Object.keys(u.lists).sort((a,b)=>{
    const na=u.lists[a]?.name||a, nb=u.lists[b]?.name||b;
    return na.localeCompare(nb);
  }).map(lsid => ({
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

  return {
    id: `org.mylists.${u.uid}`,
    version: `12.0.0-${u.rev}`,
    name: `My Lists (${u.uid})`,
    description: "Your IMDb lists as Stremio catalogs.",
    resources: ["catalog","meta"],
    types: ["my lists","movie","series"],
    idPrefixes: ["tt"],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
      configurationUrl: `${baseUrl}/u/${u.uid}/admin?key=${u.key}`
    },
    catalogs
  };
}

app.get("/u/:uid/manifest.json", async (req,res)=>{
  const uid = req.params.uid;
  const u = await loadUser(uid);
  if (!u) return res.status(404).send("Not found.");
  maybeBackgroundSync(u);
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"] || req.get("host");
  const base  = `${proto}://${host}`;
  res.json(manifestForUser(u, base));
});

function parseExtra(extraStr, qObj){
  const p = new URLSearchParams(extraStr||"");
  return { ...Object.fromEntries(p.entries()), ...(qObj||{}) };
}

app.get("/u/:uid/catalog/:type/:id/:extra?.json", async (req,res)=>{
  const uid = req.params.uid;
  const u = await loadUser(uid);
  if (!u) return res.json({ metas: [] });
  maybeBackgroundSync(u);

  const { id } = req.params;
  if (!id || !id.startsWith("list:")) return res.json({ metas: [] });
  const lsid = id.slice(5);
  const list = u.lists[lsid];
  if (!list) return res.json({ metas: [] });

  const extra = parseExtra(req.params.extra, req.query);
  const q = String(extra.search||"").toLowerCase().trim();
  const sortReq = String(extra.sort||"").toLowerCase();
  const defSort = (u.prefs.perListSort && u.prefs.perListSort[lsid]) || "name_asc";
  const sort = sortReq || defSort;
  const skip = Math.max(0, Number(extra.skip||0));
  const limit = Math.min(Number(extra.limit||100), 200);

  let metas = (list.ids||[]).map(tt => u.cache.CARD.get(tt) || cardFor(u, tt));

  if (q) {
    metas = metas.filter(m =>
      (m.name||"").toLowerCase().includes(q) ||
      (m.id||"").toLowerCase().includes(q) ||
      (m.description||"").toLowerCase().includes(q)
    );
  }

  if (sort === "custom") metas = applyCustomOrder(metas, u.prefs.customOrder?.[lsid] || []);
  else metas = stableSort(metas, sort);

  res.json({ metas: metas.slice(skip, skip+limit) });
});

app.get("/u/:uid/meta/:type/:id.json", async (req,res)=>{
  const uid = req.params.uid;
  const u = await loadUser(uid);
  if (!u) return res.json({ meta:{ id: req.params.id, type:"movie", name:"Unknown item" } });

  const imdbId = req.params.id;
  if (!isImdb(imdbId)) return res.json({ meta:{ id: imdbId, type:"movie", name:"Unknown item" } });

  let rec = u.cache.BEST.get(imdbId);
  if (!rec) rec = await getBestMeta(u, imdbId);
  if (!rec || !rec.meta) {
    const fb = u.cache.FALL.get(imdbId) || {};
    return res.json({ meta: { id: imdbId, type: rec?.kind || fb.type || "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
  }
  res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
});

// ----- Admin APIs -----
app.get("/u/:uid/api/state", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Not found");
  if (!requireUserKey(u, req, res)) return;
  res.json({
    uid: u.uid,
    imdbUrl: u.imdbUrl,
    lastSyncAt: u.lastSyncAt,
    rev: u.rev,
    lists: u.lists,
    prefs: u.prefs
  });
});

app.post("/u/:uid/api/sync", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Not found");
  if (!requireUserKey(u, req, res)) return;
  await syncUser(u, { rediscover:true });
  scheduleNextSync(u);
  res.type("text").send("Synced.");
});

app.post("/u/:uid/api/purge-sync", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Not found");
  if (!requireUserKey(u, req, res)) return;
  u.lists = Object.create(null);
  u.cache.BEST.clear(); u.cache.FALL.clear(); u.cache.EP2SER.clear(); u.cache.CARD.clear();
  await syncUser(u, { rediscover:true });
  scheduleNextSync(u);
  res.type("text").send("Purged & synced.");
});

app.get("/u/:uid/api/list-items", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Not found");
  if (!requireUserKey(u, req, res)) return;
  const lsid = String(req.query.lsid||"");
  const list = u.lists[lsid];
  if (!list) return res.json({ items: [] });
  const items = (list.ids||[]).map(tt => u.cache.CARD.get(tt) || cardFor(u, tt));
  res.json({ items });
});

app.post("/u/:uid/api/save-prefs", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Not found");
  if (!requireUserKey(u, req, res)) return;

  const body = req.body || {};
  u.prefs.enabled         = Array.isArray(body.enabled) ? body.enabled.filter(isList) : [];
  u.prefs.order           = Array.isArray(body.order)   ? body.order.filter(isList)   : [];
  u.prefs.defaultList     = isList(body.defaultList) ? body.defaultList : "";
  u.prefs.perListSort     = (body.perListSort && typeof body.perListSort==="object") ? body.perListSort : (u.prefs.perListSort || {});
  u.prefs.upgradeEpisodes = !!body.upgradeEpisodes;

  // bump rev and persist
  u.rev++;
  await storeUser(u.uid, toUserJson(u));

  res.type("text").send("Saved. Manifest rev " + u.rev);
});

app.post("/u/:uid/api/custom-order", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Not found");
  if (!requireUserKey(u, req, res)) return;
  const lsid = String(req.body.lsid || "");
  const order = Array.isArray(req.body.order) ? req.body.order.filter(isImdb) : [];
  if (!isList(lsid) || !u.lists[lsid]) return res.status(400).send("Bad list");

  const set = new Set(u.lists[lsid].ids);
  const clean = order.filter(id => set.has(id));
  u.prefs.customOrder = u.prefs.customOrder || {};
  u.prefs.customOrder[lsid] = clean;
  u.prefs.perListSort = u.prefs.perListSort || {};
  u.prefs.perListSort[lsid] = "custom";

  u.rev++;
  await storeUser(u.uid, toUserJson(u));
  res.json({ ok:true, rev:u.rev });
});

// add a list by URL or ID
app.post("/u/:uid/api/add-list", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Not found");
  if (!requireUserKey(u, req, res)) return;

  let input = String(req.body.src || "").trim();
  let lsid = "";
  const m = input.match(/ls\d{6,}/i);
  if (m) lsid = m[0];
  if (!lsid) return res.status(400).send("No list id found.");

  const url = `https://www.imdb.com/list/${lsid}/`;
  let name = lsid;
  try { name = await fetchListName(url); } catch {}

  // fetch items
  let ids = [];
  try { ids = await fetchImdbListIdsAllPages(url); } catch {}

  u.lists[lsid] = { id: lsid, name, url, ids };
  // enable by default and push into order if not present
  if (!u.prefs.enabled.includes(lsid)) u.prefs.enabled.push(lsid);
  if (!u.prefs.order.includes(lsid)) u.prefs.order.push(lsid);

  u.rev++;
  await storeUser(u.uid, toUserJson(u));
  res.type("text").send("Added.");
});

// Admin page (per user)
app.get("/u/:uid/admin", async (req,res)=>{
  const u = await loadUser(req.params.uid);
  if (!u) return res.status(404).send("Not found");
  if (!requireUserKey(u, req, res)) return;

  const lastTxt = u.lastSyncAt ? (new Date(u.lastSyncAt).toLocaleString() + " (" + Math.round((Date.now()-u.lastSyncAt)/60000) + " min ago)") : "never";

  res.type("html").send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Admin (${u.uid})</title>
<style>
  body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:1100px}
  .card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0;background:#fff}
  button{padding:10px 16px;border:0;border-radius:8px;background:#2d6cdf;color:#fff;cursor:pointer}
  .btn2{background:#6c5ce7}
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
  input[type=text]{padding:8px 10px;border:1px solid #ccc;border-radius:8px}
</style>
</head><body>
<h1>My Lists – Admin <small class="muted">(${u.uid})</small></h1>

<div class="card">
  <h3>Current Snapshot</h3>
  <ul id="snap"></ul>
  <p><small>Last sync: ${lastTxt}. Rev ${u.rev}. Auto-sync every ${IMDB_SYNC_MINUTES} min.</small></p>
  <div class="rowtools">
    <form method="POST" action="/u/${u.uid}/api/sync?key=${u.key}"><button class="btn2">Sync IMDb Lists Now</button></form>
    <form method="POST" action="/u/${u.uid}/api/purge-sync?key=${u.key}" onsubmit="return confirm('Purge caches & re-sync?')"><button>🧹 Purge & Sync</button></form>
    <span class="inline-note">Manifest: <span class="code">/u/${u.uid}/manifest.json</span></span>
  </div>
</div>

<div class="card">
  <h3>Customize (enable/disable, order, defaults)</h3>
  <p class="muted">Drag rows to change order. Click ▾ to open a list and drag posters to set a <b>custom</b> order (saved per list).</p>
  <div class="rowtools" style="margin-bottom:8px">
    <form id="addListForm">
      <input type="text" id="addListInput" placeholder="Add list by URL or lsXXXX (optional)" />
      <button>Add list</button>
    </form>
    <span class="inline-note">You can merge lists from any IMDb user.</span>
  </div>
  <div id="prefs"></div>
</div>

<script>
const UID=${JSON.stringify(u.uid)};
const KEY=${JSON.stringify(u.key)};

async function api(path, opts){
  const r = await fetch('/u/'+UID+path+(path.includes('?')?'&':'?')+'key='+encodeURIComponent(KEY), opts);
  if (!r.ok) throw new Error('request failed');
  const ct = r.headers.get('content-type')||'';
  if (ct.includes('application/json')) return r.json();
  return r.text();
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
    dragSrc = tr; tr.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tr.dataset.lsid || '');
  });
  tbody.addEventListener('dragend', () => { if (dragSrc) dragSrc.classList.remove('dragging'); dragSrc=null; });
  tbody.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragSrc) return;
    const over = e.target.closest('tr[data-lsid]');
    if (!over || over===dragSrc) return;
    const rect = over.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height/2;
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
  const state = await api('/api/state');
  // snapshot list
  const UL = document.getElementById('snap'); UL.innerHTML='';
  const names = Object.keys(state.lists).map(k=>({k, n:state.lists[k]?.name||k, c:(state.lists[k]?.ids||[]).length, u:state.lists[k]?.url||""}))
    .sort((a,b)=>a.n.localeCompare(b.n));
  names.forEach(x=>{
    UL.appendChild(el('li',{},[el('b',{text:x.n}), el('span',{html:' <small>('+(x.c||0)+' items)</small><br/>'}), el('small',{text:x.u})]));
  });

  // prefs table
  const prefs = state.prefs;
  const lists = state.lists;
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
    api('/api/list-items?lsid='+encodeURIComponent(lsid)).then(({items})=>{
      td.innerHTML = '';
      const tools = el('div', {class:'rowtools'});
      const saveBtn = el('button',{text:'Save order'});
      const resetBtn = el('button',{text:'Reset'});
      tools.appendChild(saveBtn); tools.appendChild(resetBtn);
      td.appendChild(tools);

      const co = (prefs.customOrder && prefs.customOrder[lsid]) || [];
      const pos = new Map(co.map((id,i)=>[id,i]));
      const ordered = items.slice().sort((a,b)=>{
        const pa = pos.has(a.id)?pos.get(a.id):1e9;
        const pb = pos.has(b.id)?pos.get(b.id):1e9;
        return pa-pb;
      });

      const ul = el('ul',{class:'thumbs'});
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
          await api('/api/custom-order', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid, order: ids }) });
          saveBtn.textContent = "Saved ✓";
          setTimeout(()=> saveBtn.textContent = "Save order", 1500);
        } catch(e) {
          alert("Failed to save custom order");
        } finally {
          saveBtn.disabled = false; resetBtn.disabled = false;
        }
      };
      resetBtn.onclick = ()=>{ ul.innerHTML=''; for(const it of items){ const li=el('li',{class:'thumb','data-id':it.id,draggable:'true'}); li.appendChild(el('img',{src:it.poster||'',alt:''})); const wrap=el('div',{},[el('div',{class:'title',text:it.name||it.id}), el('div',{class:'id',text:it.id})]); li.appendChild(wrap); ul.appendChild(li);} attachThumbDnD(ul); };
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

  order.forEach(lsid => tbody.appendChild(makeRow(lsid)));
  table.appendChild(tbody);
  attachRowDnD(tbody);
  container.appendChild(table);

  // Save prefs
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
      defaultList: (prefs.defaultList || enabled[0] || ""),
      perListSort: prefs.perListSort || {},
      upgradeEpisodes: prefs.upgradeEpisodes || false
    };
    msg.textContent = "Saving…";
    const t = await api('/api/save-prefs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    msg.textContent = t || "Saved.";
    setTimeout(()=>{ msg.textContent = ""; }, 2200);
  };

  // Add list
  const addForm = document.getElementById('addListForm');
  addForm.onsubmit = async (e)=>{
    e.preventDefault();
    const src = document.getElementById('addListInput').value.trim();
    if (!src) return;
    try{
      await api('/api/add-list', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ src }) });
      location.reload();
    }catch(e){ alert('Failed to add list'); }
  };
}
render();
</script>
</body></html>`);
});

// Health
app.get("/health", (_,res)=>res.status(200).send("ok"));

// ---------- BOOT ----------
(async () => {
  // optional: precreate bootstrap user
  if (BOOT_IMDB_USER_URL) {
    try {
      const found = await findUserByImdb(BOOT_IMDB_USER_URL);
      if (found) {
        const u = fromUserJson(found.json);
        USERS.set(u.uid, u);
        maybeBackgroundSync(u);
      } else {
        await createUser(BOOT_IMDB_USER_URL);
      }
    } catch (e) { console.warn("boot user:", e.message); }
  }

  app.listen(PORT, HOST, () => {
    console.log(`My Lists running on http://localhost:${PORT}`);
  });
})();
