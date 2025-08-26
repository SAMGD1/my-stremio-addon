/* My Lists – IMDb → Stremio (stable)
 * - CommonJS (no ESM issues on Render)
 * - Safe manifest.version bumping
 * - Discovery from IMDB_USER_URL; if empty, uses IMDB_LISTS whitelist
 * - Robust pagination; de-dupe; optional episode→series upgrade
 * - Fast & resilient meta: Cinemeta → IMDb JSON-LD/OG fallback
 * - Admin: sync button + discovered lists + manifest URL
 */

const express = require("express");

// ---------- ENV ----------
const PORT  = Number(process.env.PORT || 7000);
const HOST  = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

// optional whitelist: IMDB_LISTS='[{"name":"Marvel Movies","url":"https://www.imdb.com/list/ls4107759378/"}]'
const IMDB_LISTS_JSON   = process.env.IMDB_LISTS || "[]";

const UA        = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/11.0";
const CINEMETA  = "https://v3-cinemeta.strem.io";

// ---------- STATE ----------
/** LISTS: { [lsid]: { id, name, url, ids: string[] } } */
let LISTS = Object.create(null);
/** cache: imdb tt → { kind:'movie'|'series'|null, meta?:object|null } */
const BEST = new Map();
/** fallback (from IMDb page): tt -> {name,poster,year,releaseDate,type} */
const FALLBK = new Map();
/** prebuilt catalog cards */
const CARD = new Map();
/** episode → parent series mapping */
const EP2SER = new Map();

/** prefs */
let UPGRADE_EPISODES = true;

/** sync + manifest tracking */
let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;
let MANIFEST_REV = 1;

// ---------- tiny utils ----------
const isImdb  = v => /^tt\d{7,}$/i.test(String(v||""));
const isList  = v => /^ls\d{6,}$/i.test(String(v||""));
const minutes = ms => Math.round(ms/60000);

async function fetchText(url, accept = "text/html,*/*") {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": accept } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}
const withParam = (url, k, v) => { const u = new URL(url); u.searchParams.set(k, String(v)); return u.toString(); };

// ---------- IMDb discovery & parsing ----------
function parseWhitelist() {
  try {
    const arr = JSON.parse(IMDB_LISTS_JSON);
    return Array.isArray(arr) ? arr.filter(x => x && x.url).map(x => ({
      id: (x.url.match(/ls\d{6,}/) || [])[0],
      url: x.url,
      name: x.name || (x.url.match(/ls\d{6,}/) || [])[0]
    })).filter(x => isList(x.id)) : [];
  } catch { return []; }
}

async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(withParam(userListsUrl, "_", Date.now()));
  const re = /href="\/list\/(ls\d{6,})\/"/gi;
  const ids = new Set();
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (!ids.has(id)) {
      ids.add(id);
      out.push({ id, url: `https://www.imdb.com/list/${id}/`, name: id });
    }
  }
  // resolve names cheaply
  await Promise.all(out.map(async L => {
    try { L.name = await fetchListName(L.url); } catch { /* keep id */ }
  }));
  return out;
}

async function fetchListName(listUrl) {
  const html = await fetchText(withParam(listUrl, "_", Date.now()));
  const tries = [
    /<h1[^>]+data-testid="list-header-title"[^>]*>(.*?)<\/h1>/i,
    /<h1[^>]*class="[^"]*header[^"]*"[^>]*>(.*?)<\/h1>/i,
    /<title>(.*?)<\/title>/i
  ];
  for (const rx of tries) {
    const m = html.match(rx);
    if (m) {
      const name = m[1].replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
      if (name) return name;
    }
  }
  return listUrl;
}

function parseTconsts(html) {
  const seen = new Set(), out = [];
  let m;
  const re1 = /data-tconst="(tt\d{7,})"/gi;
  while ((m = re1.exec(html))) { const tt = m[1]; if (!seen.has(tt)) { seen.add(tt); out.push(tt); } }
  const re2 = /\/title\/(tt\d{7,})\//gi;
  while ((m = re2.exec(html))) { const tt = m[1]; if (!seen.has(tt)) { seen.add(tt); out.push(tt); } }
  return out;
}
function findNext(html) {
  let m = html.match(/rel="next"[^>]+href="([^"]+)"/i);
  if (!m) m = html.match(/class="[^"]*lister-page-next[^"]*"[^>]+href="([^"]+)"/i);
  if (!m) m = html.match(/data-testid="pagination-next-page-button"[^>]+href="([^"]+)"/i);
  if (!m) return null;
  try { return new URL(m[1], "https://www.imdb.com").toString(); } catch { return null; }
}

async function fetchListAllPages(listUrl, maxPages = 60) {
  const modes = ["detail","grid","compact"];
  const seen = new Set(), ids = [];
  for (const mode of modes) {
    let url = withParam(listUrl, "mode", mode);
    let pages = 0;
    while (url && pages < maxPages) {
      let html; try { html = await fetchText(withParam(url,"_",Date.now())); } catch { break; }
      const found = parseTconsts(html);
      let added = 0;
      for (const tt of found) if (!seen.has(tt)) { seen.add(tt); ids.push(tt); added++; }
      pages++;
      const next = findNext(html);
      if (!next || added === 0) break;
      url = next;
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

async function imdbJSONLD(imdbId) {
  try {
    const html = await fetchText(`https://www.imdb.com/title/${imdbId}/`);
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (m) { try { return JSON.parse(m[1]); } catch {} }
    // OG fallback
    const t = html.match(/property="og:title"[^>]+content="([^"]+)"/i);
    const p = html.match(/property="og:image"[^>]+content="([^"]+)"/i);
    return { name: t ? t[1] : undefined, image: p ? p[1] : undefined };
  } catch { return null; }
}

async function resolveEpisodeToSeries(imdbId) {
  if (EP2SER.has(imdbId)) return EP2SER.get(imdbId);
  const ld = await imdbJSONLD(imdbId);
  let seriesId = null;
  try {
    const node = Array.isArray(ld && ld["@graph"]) ? ld["@graph"].find(x => x["@type"] === "TVEpisode") : ld;
    const part = node && (node.partOfSeries || node.partOfTVSeries || (node.partOfSeason && node.partOfSeason.partOfSeries));
    const url = typeof part === "string" ? part : (part && (part.url || part.sameAs || part["@id"]));
    const m = url && String(url).match(/tt\d{7,}/i);
    if (m) seriesId = m[0];
  } catch {}
  if (seriesId) EP2SER.set(imdbId, seriesId);
  return seriesId;
}

async function getBestMeta(imdbId) {
  if (BEST.has(imdbId)) return BEST.get(imdbId);

  // Cinemeta movie→series
  let meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind:"movie", meta }; BEST.set(imdbId, rec); return rec; }
  meta = await fetchCinemeta("series", imdbId);
  if (meta) { const rec = { kind:"series", meta }; BEST.set(imdbId, rec); return rec; }

  // IMDb JSON-LD (fallback)
  const ld = await imdbJSONLD(imdbId);
  let name, poster, released, year, type;
  try {
    const node = Array.isArray(ld && ld["@graph"]) ? ld["@graph"].find(x => String(x["@id"]||"").includes(`/title/${imdbId}`)) || ld["@graph"][0] : ld;
    name = node?.name || node?.headline || ld?.name;
    poster = (typeof node?.image === "string" ? node.image : node?.image?.url) || ld?.image;
    released = node?.datePublished || node?.startDate || node?.releaseDate;
    year = released ? Number(String(released).slice(0,4)) : undefined;
    const t = (Array.isArray(node?.["@type"]) ? node["@type"][0] : node?.["@type"]) || "";
    if (/Series/i.test(t)) type = "series";
    else if (/TVEpisode/i.test(t)) type = "episode";
    else type = "movie";
  } catch {}

  const rec = { kind: type === "series" ? "series" : "movie", meta: name ? { name, poster, released, year } : null };
  BEST.set(imdbId, rec);
  if (name || poster) FALLBK.set(imdbId, { name, poster, releaseDate: released, year, type: rec.kind });
  return rec;
}

function toTs(dateStr, year) {
  if (dateStr) { const n = Date.parse(dateStr); if (!Number.isNaN(n)) return n; }
  if (year)    { const n = Date.parse(`${year}-01-01`); if (!Number.isNaN(n)) return n; }
  return null;
}

function buildCard(tt) {
  const rec = BEST.get(tt) || { kind:null, meta:null };
  const m = rec.meta || {};
  const fb = FALLBK.get(tt) || {};
  return {
    id: tt,
    type: rec.kind || fb.type || "movie",
    name: m.name || fb.name || tt,
    poster: m.poster || fb.poster || undefined,
    imdbRating: m.imdbRating ?? undefined,
    runtime: m.runtime ?? undefined,
    year: m.year ?? fb.year ?? undefined,
    releaseDate: m.released ?? m.releaseInfo ?? fb.releaseDate ?? undefined,
    description: m.description || undefined
  };
}

// ---------- SYNC ----------
async function fullSync({ rediscover = true } = {}) {
  if (syncInProgress) return;
  syncInProgress = true;
  const started = Date.now();
  try {
    // 1) find lists
    let lists = [];
    const wl = parseWhitelist();
    if (wl.length) {
      lists = wl;
    } else if (IMDB_USER_URL && rediscover) {
      try { lists = await discoverListsFromUser(IMDB_USER_URL); }
      catch (e) { console.warn("IMDb discovery failed:", e.message); }
    }
    if (!lists.length) {
      console.warn("[SYNC] no lists discovered; keeping previous snapshot.");
      lists = Object.values(LISTS).map(L => ({ id:L.id, name:L.name, url:L.url }));
    }

    // 2) fetch items per list (paginate)
    const next = Object.create(null);
    const all = new Set();
    for (const L of lists) {
      const url = L.url || `https://www.imdb.com/list/${L.id}/`;
      let ids = [];
      try { ids = await fetchListAllPages(url); } catch {}
      next[L.id] = { id: L.id, name: L.name || L.id, url, ids };
      ids.forEach(tt => all.add(tt));
    }

    // 3) preload metas; optionally upgrade episodes to series
    let idsAll = Array.from(all);
    if (UPGRADE_EPISODES) {
      const set = new Set();
      for (const tt of idsAll) {
        const rec = await getBestMeta(tt);
        const fb = FALLBK.get(tt);
        const looksLikeEp = (fb && fb.type === "episode");
        if (looksLikeEp) {
          const ser = await resolveEpisodeToSeries(tt);
          if (ser && isImdb(ser)) set.add(ser); else set.add(tt);
        } else set.add(tt);
      }
      idsAll = Array.from(set);
      // also remap each list
      for (const id of Object.keys(next)) {
        const seen = new Set(), remap = [];
        for (const tt of next[id].ids) {
          let f = tt;
          const fb = FALLBK.get(tt);
          if (UPGRADE_EPISODES && fb && fb.type === "episode") {
            const ser = await resolveEpisodeToSeries(tt);
            if (ser) f = ser;
          }
          if (!seen.has(f)) { seen.add(f); remap.push(f); }
        }
        next[id].ids = remap;
      }
    }

    for (const tt of idsAll) { await getBestMeta(tt); }
    CARD.clear();
    for (const tt of idsAll) CARD.set(tt, buildCard(tt));

    LISTS = next;
    LAST_SYNC_AT = Date.now();
    MANIFEST_REV++; // safe bump

    console.log(`[SYNC] ok – ${idsAll.length} ids across ${Object.keys(LISTS).length} lists in ${minutes(Date.now()-started)} min`);
  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    syncInProgress = false;
  }
}

function scheduleNextSync() {
  if (syncTimer) clearTimeout(syncTimer);
  if (IMDB_SYNC_MINUTES <= 0) return;
  syncTimer = setTimeout(async () => {
    await fullSync({ rediscover: true });
    scheduleNextSync();
  }, IMDB_SYNC_MINUTES * 60 * 1000);
}

function maybeBackgroundSync() {
  if (IMDB_SYNC_MINUTES <= 0) return;
  const tooOld = Date.now() - LAST_SYNC_AT > IMDB_SYNC_MINUTES * 60 * 1000;
  if (tooOld && !syncInProgress) fullSync({ rediscover: true }).then(scheduleNextSync);
}

// ---------- server ----------
const app = express();
app.use((_, res, next) => { res.setHeader("Access-Control-Allow-Origin","*"); next(); });

const baseManifest = {
  id: "org.mylists.stable",
  version: "11.0.0",
  name: "My Lists",
  description: "Your IMDb lists in Stremio (fast, cached).",
  resources: ["catalog","meta"],
  types: ["my lists","movie","series"],
  idPrefixes: ["tt"]
};

function addonAllowed(req) {
  if (!SHARED_SECRET) return true;
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return u.searchParams.get("key") === SHARED_SECRET;
}
function adminAllowed(req) {
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return (u.searchParams.get("admin") || req.headers["x-admin-key"]) === ADMIN_PASSWORD;
}
function absoluteBase(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

app.get("/health", (_,res) => res.status(200).send("ok"));

function catalogs() {
  return Object.keys(LISTS).map(lsid => ({
    type: "My lists",
    id: `list:${lsid}`,
    name: `🗂 ${LISTS[lsid]?.name || lsid}`,
    extraSupported: ["search","skip","limit","sort"],
    extra: [
      { name:"search" }, { name:"skip" }, { name:"limit" },
      { name:"sort", options: ["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"] }
    ],
    posterShape: "poster"
  }));
}

app.get("/manifest.json", (req,res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    res.setHeader("Cache-Control","no-store");
    const version = `${baseManifest.version}.${MANIFEST_REV}`; // safe bump
    res.json({ ...baseManifest, version, catalogs: catalogs() });
  } catch (e) {
    console.error("manifest:", e);
    res.status(500).send("Internal Server Error");
  }
});

function parseExtra(extraStr, query) {
  const params = new URLSearchParams(extraStr || "");
  const fromPath = Object.fromEntries(params.entries());
  return { ...fromPath, ...(query || {}) };
}

function sortMetas(metas, key) {
  const s = String(key || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const field = s.split("_")[0];
  const cmpNullBottom = (a,b) => {
    const na = a==null, nb = b==null;
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return a<b?-1:a>b?1:0;
  };
  return metas
    .map((m,i)=>({m,i}))
    .sort((A,B)=>{
      const a=A.m, b=B.m;
      let c=0;
      if (field==="date") c = cmpNullBottom(toTs(a.releaseDate,a.year), toTs(b.releaseDate,b.year));
      else if (field==="rating") c = cmpNullBottom(a.imdbRating??null, b.imdbRating??null);
      else if (field==="runtime") c = cmpNullBottom(a.runtime??null, b.runtime??null);
      else c = (a.name||"").localeCompare(b.name||"");
      if (c===0) {
        c = (a.name||"").localeCompare(b.name||"");
        if (c===0) c = (a.id||"").localeCompare(b.id||"");
        if (c===0) c = A.i - B.i;
      }
      return c*dir;
    })
    .map(x=>x.m);
}

app.get("/catalog/:type/:id/:extra?.json", async (req,res)=>{
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const { id } = req.params;
    if (!id || !id.startsWith("list:")) return res.json({ metas: [] });
    const lsid = id.slice(5);
    const list = LISTS[lsid];
    if (!list) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q = String(extra.search || "").toLowerCase().trim();
    const sort = String(extra.sort || "name_asc").toLowerCase();
    const skip  = Math.max(0, Number(extra.skip || 0));
    const limit = Math.min(Number(extra.limit || 100), 200);

    let metas = (list.ids || []).map(tt => CARD.get(tt) || buildCard(tt));
    if (q) metas = metas.filter(m =>
      (m.name||"").toLowerCase().includes(q) ||
      (m.id||"").toLowerCase().includes(q) ||
      (m.description||"").toLowerCase().includes(q)
    );
    metas = sortMetas(metas, sort);
    res.json({ metas: metas.slice(skip, skip+limit) });
  } catch (e) {
    console.error("catalog:", e);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/meta/:type/:id.json", async (req,res)=>{
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const tt = req.params.id;
    if (!isImdb(tt)) return res.json({ meta: { id: tt, type:"movie", name:"Unknown item" } });

    let rec = BEST.get(tt);
    if (!rec) rec = await getBestMeta(tt);

    if (!rec || !rec.meta) {
      const fb = FALLBK.get(tt) || {};
      return res.json({ meta: { id: tt, type: rec?.kind || fb.type || "movie", name: fb.name || tt, poster: fb.poster || undefined } });
    }
    res.json({ meta: { ...rec.meta, id: tt, type: rec.kind } });
  } catch (e) {
    console.error("meta:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ---------- admin ----------
function absoluteBase(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

app.get("/admin", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  let discovered = [];
  try { if (IMDB_USER_URL) discovered = await discoverListsFromUser(IMDB_USER_URL); } catch {}
  const disc = discovered.length
    ? `<ul>${discovered.map(d=>`<li><b>${d.name||d.id}</b><br/><small>${d.url}</small></li>`).join("")}</ul>`
    : "<p><small>(none found or IMDb unreachable right now).</small></p>";

  const rows = Object.keys(LISTS).length
    ? `<ul>${Object.keys(LISTS).map(id=>`<li><b>${LISTS[id].name||id}</b> <small>(${(LISTS[id].ids||[]).length} items)</small><br/><small>${LISTS[id].url}</small></li>`).join("")}</ul>`
    : "<p>(none)</p>";

  const manifestUrl = `${absoluteBase(req)}/manifest.json${SHARED_SECRET?`?key=${SHARED_SECRET}`:""}`;

  res.type("html").send(`<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>My Lists – Admin</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:760px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
button{padding:10px 16px;border:0;border-radius:8px;background:#2d6cdf;color:#fff;cursor:pointer}
small{color:#666}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}
</style>
</head><body>
<h1>My Lists – Admin</h1>

<div class="card">
  <h3>Current Snapshot</h3>
  ${rows}
  <p><small>Last sync: ${LAST_SYNC_AT ? new Date(LAST_SYNC_AT).toLocaleString() + " (" + minutes(Date.now()-LAST_SYNC_AT) + " min ago)" : "never"}</small></p>
  <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}">
    <button>Sync IMDb Lists Now</button>
  </form>
  <p><small>Auto-sync every ${IMDB_SYNC_MINUTES} min.</small></p>
</div>

<div class="card">
  <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
  ${disc}
</div>

<div class="card">
  <h3>Manifest URL</h3>
  <p class="code">${manifestUrl}</p>
</div>
</body></html>`);
});

app.post("/api/sync", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    await fullSync({ rediscover: true });
    scheduleNextSync();
    res.status(200).send(`Synced at ${new Date().toISOString()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

// ---------- boot ----------
(async () => {
  await fullSync({ rediscover: true });
  scheduleNextSync();
  app.listen(PORT, HOST, () => {
    console.log("Admin:    http://localhost:%s/admin?admin=%s", PORT, ADMIN_PASSWORD);
    console.log("Manifest: http://localhost:%s/manifest.json%s", PORT, SHARED_SECRET?`?key=${SHARED_SECRET}`:"");
  });
})();
