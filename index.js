/* My Lists – IMDb → Stremio (stable, resilient, customizable)
 * Version: 11.2.0 (manifest patch rev bumps automatically)
 * Author: you + ChatGPT
 */

const express = require("express");
const crypto = require("crypto");

// ----------------- ENV -----------------
const PORT  = Number(process.env.PORT || 10000);
const HOST  = "0.0.0.0";

const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET    = process.env.SHARED_SECRET || "";
const IMDB_USER_URL    = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_SYNC_MINUTES= Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));
const OMDB_API_KEY     = process.env.OMDB_API_KEY || ""; // optional

const CINEMETA = "https://v3-cinemeta.strem.io";
const BASE_VERSION = "11.2.0";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ----------------- STATE -----------------
/** @type {Record<string,{id:string,name:string,url:string,ids:string[]}>} */
let LISTS = Object.create(null);

let PREFS = {
  enabled: [],           // ls ids enabled; [] means all discovered
  order: [],             // ls ids in display order
  defaultList: "",       // a specific lsid, or empty to use first enabled
  perListSort: {},       // { lsid: "date_asc" | "name_desc" | ... }
  upgradeEpisodes: true  // map TV episodes to parent series to avoid dupes
};

// caches
const BEST   = new Map(); // imdbId -> { kind, meta }
const FALLBK = new Map(); // imdbId -> { name, poster, releaseDate, year, type }
const EP2SER = new Map(); // episode imdbId -> parent series imdbId
const CARD   = new Map(); // imdbId -> meta card (id, type, name, poster, year, rating, runtime, releaseDate, description)

let MANIFEST_REV = 1;
let LAST_MANIFEST_KEY = "";
let LAST_SYNC_AT = 0;
let syncing = false;
let syncTimer = null;

// ----------------- UTILS -----------------
const isImdb = (v) => /^tt\d{7,}$/i.test(String(v || ""));
const isList = (v) => /^ls\d{6,}$/i.test(String(v || ""));
const minToMs = (m) => m * 60 * 1000;
const toTs = (d, y) => {
  if (d) { const n = Date.parse(d); if (!Number.isNaN(n)) return n; }
  if (y) { const n = Date.parse(`${y}-01-01`); if (!Number.isNaN(n)) return n; }
  return null;
};
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ---- HTTP helpers ----
async function fetchImdbHtml(url) {
  const u = new URL(url);
  u.searchParams.set("_", String(Date.now()));

  const r = await fetch(u.toString(), {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Referer": "https://www.imdb.com/",
      "Connection": "keep-alive"
    }
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
function looksLikeRealImdbLists(html) {
  if (!html || html.length < 1024) return false;
  if (/id="service-captcha"|g-recaptcha|Sign\s*In/i.test(html)) return false;
  return /\/list\/ls\d{6,}/i.test(html);
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept":"application/json" } });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

// --------------- IMDb discovery ---------------
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchImdbHtml(userListsUrl);
  if (!looksLikeRealImdbLists(html)) {
    throw new Error("IMDb lists page looks invalid (wall/login)");
  }

  const ids = new Set();
  const found = [];
  const rx = /\/list\/(ls\d{6,})\/?/gi;
  let m;
  while ((m = rx.exec(html))) {
    const id = m[1];
    if (!ids.has(id)) {
      ids.add(id);
      found.push({ id, url: `https://www.imdb.com/list/${id}/` });
    }
  }

  await Promise.all(found.map(async (L) => {
    try {
      const h = await fetchImdbHtml(L.url);
      const tries = [
        /<h1[^>]+data-testid="list-header-title"[^>]*>(.*?)<\/h1>/i,
        /<h1[^>]*class="[^"]*header[^"]*"[^>]*>(.*?)<\/h1>/i,
        /<title>(.*?)<\/title>/i
      ];
      for (const rx of tries) {
        const mm = h.match(rx);
        if (mm) {
          L.name = mm[1].replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
          break;
        }
      }
      if (!L.name) L.name = L.id;
    } catch {
      L.name = L.id;
    }
  }));

  return found;
}

// ---- Parse IMDb list page ----
function parseTconsts(html) {
  const seen = new Set();
  const out = [];
  // prefer data-tconst
  const re1 = /data-tconst="(tt\d{7,})"/gi;
  let m;
  while ((m = re1.exec(html))) {
    const tt = m[1];
    if (!seen.has(tt)) { seen.add(tt); out.push(tt); }
  }
  // fallback: /title/tt#######
  const re2 = /\/title\/(tt\d{7,})\//gi;
  while ((m = re2.exec(html))) {
    const tt = m[1];
    if (!seen.has(tt)) { seen.add(tt); out.push(tt); }
  }
  return out;
}
function findNextPage(html) {
  let m = html.match(/<a[^>]+rel="next"[^>]+href="([^"]+)"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*lister-page-next[^"]*"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*data-testid="pagination-next-page-button"[^>]*>/i);
  if (!m) return null;
  try { return new URL(m[1], "https://www.imdb.com").toString(); }
  catch { return null; }
}
async function fetchListItemsAllPages(listUrl, maxPages = 80) {
  const modes = ["detail", "grid", "compact"];
  const seen = new Set();
  const ids = [];

  for (const mode of modes) {
    let url = new URL(listUrl);
    url.searchParams.set("mode", mode);
    let pageUrl = url.toString();
    let pages = 0;
    while (pageUrl && pages < maxPages) {
      let html;
      try { html = await fetchImdbHtml(pageUrl); }
      catch { break; }
      const found = parseTconsts(html);
      let added = 0;
      for (const tt of found) {
        if (!seen.has(tt)) { seen.add(tt); ids.push(tt); added++; }
      }
      pages++;
      const next = findNextPage(html);
      if (!next || added === 0) break;
      pageUrl = next;
      await delay(100); // be nice
    }
    if (ids.length) break;
  }
  return ids;
}

// ----------------- Metadata -----------------
async function fetchCinemeta(kind, imdbId) {
  const j = await fetchJson(`${CINEMETA}/meta/${kind}/${imdbId}.json`);
  return j && j.meta ? j.meta : null;
}
async function omdbById(imdbId) {
  if (!OMDB_API_KEY) return null;
  const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(OMDB_API_KEY)}&i=${encodeURIComponent(imdbId)}`;
  return fetchJson(url);
}
async function imdbTitleJsonLd(imdbId) {
  try {
    const html = await fetchImdbHtml(`https://www.imdb.com/title/${imdbId}/`);
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (m) {
      try { return JSON.parse(m[1]); }
      catch { /* ignore */ }
    }
    // OG fallback
    const t = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    const p = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    return { name: t ? t[1] : undefined, image: p ? p[1] : undefined };
  } catch { return null; }
}
// Episode -> parent series
async function resolveEpisodeToSeries(imdbId) {
  if (EP2SER.has(imdbId)) return EP2SER.get(imdbId);
  const ld = await imdbTitleJsonLd(imdbId);
  let seriesId = null;
  try {
    const node = Array.isArray(ld && ld["@graph"])
      ? ld["@graph"].find(x => x["@type"] === "TVEpisode")
      : ld;
    const part = node && (node.partOfSeries || node.partOfTVSeries || (node.partOfSeason && node.partOfSeason.partOfSeries));
    if (part) {
      const url = typeof part === "string" ? part : (part.url || part.sameAs || part["@id"]);
      if (url) {
        const m = String(url).match(/tt\d{7,}/i);
        if (m) seriesId = m[0];
      }
    }
  } catch {}
  if (seriesId) EP2SER.set(imdbId, seriesId);
  return seriesId;
}

async function getBestMeta(imdbId) {
  if (BEST.has(imdbId)) return BEST.get(imdbId);

  // Cinemeta movie/series
  let meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind: "movie", meta }; BEST.set(imdbId, rec); return rec; }
  meta = await fetchCinemeta("series", imdbId);
  if (meta) { const rec = { kind: "series", meta }; BEST.set(imdbId, rec); return rec; }

  // OMDb
  const om = await omdbById(imdbId);
  if (om && om.Response !== "False") {
    const kind = om.Type === "series" ? "series" : "movie";
    const rec = {
      kind,
      meta: {
        name: om.Title,
        year: om.Year ? Number(String(om.Year).slice(0,4)) : undefined,
        imdbRating: om.imdbRating ? Number(om.imdbRating) : undefined,
        runtime: om.Runtime ? Number(String(om.Runtime).replace(/\D+/g,"")) : undefined,
        poster: om.Poster && om.Poster !== "N/A" ? om.Poster : undefined,
        description: om.Plot && om.Plot !== "N/A" ? om.Plot : undefined,
        released: om.Released && om.Released !== "N/A" ? om.Released : undefined
      }
    };
    BEST.set(imdbId, rec);
    return rec;
  }

  // IMDb JSON-LD/OG fallback
  const ld = await imdbTitleJsonLd(imdbId);
  let name, poster, released, year, type;
  try {
    const node = Array.isArray(ld && ld["@graph"]) ? (ld["@graph"].find(x => (x["@id"]||"").includes(`/title/${imdbId}`)) || ld["@graph"][0]) : ld;
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

function buildCard(imdbId) {
  const rec = BEST.get(imdbId) || { kind: null, meta: null };
  const meta = rec.meta || {};
  const fb   = FALLBK.get(imdbId) || {};
  return {
    id: imdbId,
    type: rec.kind || fb.type || "movie",
    name: meta.name || fb.name || imdbId,
    poster: meta.poster || fb.poster || undefined,
    imdbRating: meta.imdbRating ?? undefined,
    runtime: meta.runtime ?? undefined,
    year: meta.year ?? fb.year ?? undefined,
    releaseDate: meta.released ?? meta.releaseInfo ?? fb.releaseDate ?? undefined,
    description: meta.description || undefined
  };
}

// ------------- Sorting ----------------
function sortMetas(metas, key) {
  const s = String(key || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const field = s.split("_")[0];

  const cmpNullBottom = (a, b) => {
    const na = a == null, nb = b == null;
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  return metas
    .map((m,i)=>({m,i}))
    .sort((A,B)=>{
      const a=A.m, b=B.m;
      let c=0;
      if (field === "date") c = cmpNullBottom(toTs(a.releaseDate, a.year), toTs(b.releaseDate, b.year));
      else if (field === "rating") c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
      else if (field === "runtime") c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
      else c = (a.name||"").localeCompare(b.name||"");
      if (c===0) {
        c = (a.name||"").localeCompare(b.name||"");
        if (c===0) c=(a.id||"").localeCompare(b.id||"");
        if (c===0) c=A.i-B.i;
      }
      return c*dir;
    })
    .map(x=>x.m);
}

// ---------- Manifest helpers ----------
function effectiveEnabledListIds() {
  const discovered = Object.keys(LISTS);
  if (!PREFS.enabled || !PREFS.enabled.length) return discovered;
  const set = new Set(discovered);
  return PREFS.enabled.filter(id => set.has(id));
}
function catalogs() {
  const enabled = effectiveEnabledListIds();
  // order by prefs.order; then by name
  const ordMap = new Map(enabled.map((id,i)=>[id, i+1000]));
  (PREFS.order || []).forEach((id,idx)=>{ if (ordMap.has(id)) ordMap.set(id, idx); });
  const sorted = enabled.slice().sort((a,b)=>{
    const ia = ordMap.get(a)??9999, ib=ordMap.get(b)??9999;
    if (ia!==ib) return ia-ib;
    const na = LISTS[a]?.name || a, nb = LISTS[b]?.name || b;
    return na.localeCompare(nb);
  });
  return sorted.map(lsid => ({
    type: "my lists", // keeps a "My lists" tab in Stremio
    id: `list:${lsid}`,
    name: `🗂 ${LISTS[lsid]?.name || lsid}`,
    extraSupported: ["search","skip","limit","sort"],
    extra: [
      { name:"search" }, { name:"skip" }, { name:"limit" },
      { name:"sort", options:["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"] }
    ],
    posterShape: "poster"
  }));
}
function manifestKey() {
  const enabled = (PREFS.enabled && PREFS.enabled.length) ? PREFS.enabled : Object.keys(LISTS);
  const names = enabled.map(id => LISTS[id]?.name || id).sort().join("|");
  return `${enabled.join(",")}#${PREFS.order.join(",")}#${PREFS.defaultList}#${names}`;
}

// ---------- Sync ----------
async function fullSync({ rediscover = true } = {}) {
  if (syncing) return;
  syncing = true;
  try {
    // discovery
    let discovered = [];
    if (IMDB_USER_URL && rediscover) {
      try {
        discovered = await discoverListsFromUser(IMDB_USER_URL);
      } catch (e) {
        console.warn("[DISCOVER] failed:", e.message, "— keeping previous snapshot");
        discovered = [];
      }
    }

    // next lists set
    const next = Object.create(null);
    if (discovered.length) {
      for (const d of discovered) next[d.id] = { id:d.id, name:d.name||d.id, url:d.url, ids:[] };
    } else {
      for (const id of Object.keys(LISTS)) next[id] = LISTS[id];
    }

    // fetch items per list
    const unique = new Set();
    for (const id of Object.keys(next)) {
      const url = next[id].url || `https://www.imdb.com/list/${id}/`;
      let ids = [];
      try { ids = await fetchListItemsAllPages(url); } catch {}
      next[id].ids = ids;
      ids.forEach(tt => unique.add(tt));
    }

    let idsToPreload = Array.from(unique);

    // upgrade episodes -> series
    if (PREFS.upgradeEpisodes) {
      const upgraded = new Set();
      for (const tt of idsToPreload) {
        const rec = await getBestMeta(tt);
        const fb  = FALLBK.get(tt);
        const maybeEp = fb?.type === "episode";
        if (maybeEp) {
          const ser = await resolveEpisodeToSeries(tt);
          upgraded.add(ser || tt);
        } else {
          upgraded.add(tt);
        }
      }
      idsToPreload = Array.from(upgraded);

      // remap lists, dedupe per list
      for (const id of Object.keys(next)) {
        const remapped = [];
        const seen = new Set();
        for (const tt of next[id].ids) {
          let final = tt;
          const fb = FALLBK.get(tt);
          if (fb?.type === "episode") {
            const ser = await resolveEpisodeToSeries(tt);
            if (ser) final = ser;
          }
          if (!seen.has(final)) { seen.add(final); remapped.push(final); }
        }
        next[id].ids = remapped;
      }
    }

    // preload meta + build cards
    for (const tt of idsToPreload) await getBestMeta(tt);
    CARD.clear();
    for (const tt of idsToPreload) CARD.set(tt, buildCard(tt));

    LISTS = next;
    LAST_SYNC_AT = Date.now();

    const mk = manifestKey();
    if (mk !== LAST_MANIFEST_KEY) {
      LAST_MANIFEST_KEY = mk;
      MANIFEST_REV++;
      console.log("[SYNC] catalogs changed → manifest rev", MANIFEST_REV);
    }

    console.log(`[SYNC] ok – ${idsToPreload.length} ids across ${Object.keys(LISTS).length} lists`);
  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    syncing = false;
  }
}
function scheduleSync(reset) {
  if (syncTimer) clearTimeout(syncTimer);
  if (IMDB_SYNC_MINUTES <= 0) return;
  const delayMs = minToMs(IMDB_SYNC_MINUTES);
  syncTimer = setTimeout(async ()=>{
    await fullSync({ rediscover: true });
    scheduleSync(true);
  }, reset ? delayMs : delayMs);
}

// ----------------- Server -----------------
const app = express();
app.use((_,res,next)=>{ res.setHeader("Access-Control-Allow-Origin","*"); next(); });
app.use(express.json());

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

app.get("/health", (_,res)=>res.status(200).send("ok"));

// ---- Manifest ----
app.get("/manifest.json", (req,res)=>{
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    res.setHeader("Cache-Control","no-store");

    const version = `${BASE_VERSION}.${MANIFEST_REV}`; // no spaces
    const manifest = {
      id: "org.imdblists.addon",
      version,
      name: "My Lists",
      description: "Your IMDb lists as catalogs.",
      resources: ["catalog","meta"],
      types: ["my lists","movie","series"],
      idPrefixes: ["tt"],
      catalogs: catalogs()
    };
    res.json(manifest);
  } catch (e) {
    console.error("Manifest error:", e);
    res.status(500).send("Internal error");
  }
});

// ---- Catalog ----
app.get("/catalog/:type/:id/:extra?.json", (req,res)=>{
  (async ()=>{
    try {
      if (!addonAllowed(req)) return res.status(403).send("Forbidden");
      res.setHeader("Cache-Control","no-store");
      const { id } = req.params; // id like list:ls######
      if (!id || !id.startsWith("list:")) return res.json({ metas: [] });

      const lsid = id.slice(5);
      const list = LISTS[lsid];
      if (!list) return res.json({ metas: [] });

      // parse extra (from path or query)
      const params = new URLSearchParams(req.params.extra || "");
      const extra = Object.fromEntries(params.entries());
      Object.assign(extra, req.query);

      const q     = String(extra.search || "").toLowerCase().trim();
      const sortK = (extra.sort || PREFS.perListSort?.[lsid] || "name_asc").toLowerCase();
      const skip  = Math.max(0, Number(extra.skip || 0));
      const limit = Math.min(Number(extra.limit || 100), 200);

      let metas = (list.ids || []).map(tt => CARD.get(tt) || buildCard(tt));

      if (q) {
        metas = metas.filter(m =>
          (m.name||"").toLowerCase().includes(q) ||
          (m.id||"").toLowerCase().includes(q) ||
          (m.description||"").toLowerCase().includes(q)
        );
      }

      metas = sortMetas(metas, sortK);
      const page = metas.slice(skip, skip+limit);
      res.json({ metas: page });
    } catch (e) {
      console.error("Catalog error:", e);
      res.status(500).send("Internal error");
    }
  })();
});

// ---- Meta ----
app.get("/meta/:type/:id.json", (req,res)=>{
  (async ()=>{
    try {
      if (!addonAllowed(req)) return res.status(403).send("Forbidden");
      res.setHeader("Cache-Control","no-store");
      const imdbId = req.params.id;
      if (!isImdb(imdbId)) return res.json({ meta: { id: imdbId, type:"movie", name:"Unknown item" } });

      let rec = BEST.get(imdbId);
      if (!rec) rec = await getBestMeta(imdbId);

      if (!rec || !rec.meta) {
        const fb = FALLBK.get(imdbId) || {};
        return res.json({ meta: { id: imdbId, type: rec?.kind || fb.type || "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
      }
      return res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
    } catch (e) {
      console.error("Meta error:", e);
      res.status(500).send("Internal error");
    }
  })();
});

// ---- Admin UI ----
app.get("/admin", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  const base = absoluteBase(req);
  const manifestUrl = `${base}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;

  // non-destructive discovery for display
  let discovered = [];
  try { if (IMDB_USER_URL) discovered = await discoverListsFromUser(IMDB_USER_URL); }
  catch {}

  const rows = Object.keys(LISTS).map(id=>{
    const L = LISTS[id]; const count = (L.ids||[]).length;
    return `<tr draggable="true" data-id="${id}">
      <td><input type="checkbox" class="en" checked></td>
      <td><div><b>${(L.name||id).replace(/</g,"&lt;")}</b><br><small>${id}</small></div></td>
      <td>${count}</td>
      <td>
        <select class="sort">
          ${["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"]
            .map(o=>`<option value="${o}">${o}</option>`).join("")}
        </select>
      </td>
    </tr>`;
  }).join("");

  const disc = discovered.map(d=>`<li><b>${(d.name||d.id).replace(/</g,"&lt;")}</b><br/><small>${d.url}</small></li>`).join("") || "<li>(none found or IMDb unreachable right now).</li>";

  res.type("html").send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My Lists – Admin</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:1000px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
button{padding:10px 16px;border:0;border-radius:8px;background:#6c5ce7;color:#fff;cursor:pointer}
.btn2{background:#2d6cdf}
small{color:#666}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}
table{width:100%;border-collapse:collapse}
th,td{padding:8px;border-bottom:1px solid #eee;text-align:left;vertical-align:middle}
tr[draggable="true"]{cursor:grab}
tr.dragging{opacity:0.5}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
</style>
</head>
<body>
<h1>My Lists – Admin</h1>

<div class="card">
  <h3>Current Snapshot</h3>
  <ul>${
    Object.keys(LISTS).length
      ? Object.keys(LISTS).map(id=>{
          const L=LISTS[id]; return `<li><b>${(L.name||id).replace(/</g,"&lt;")}</b> <small>(${(L.ids||[]).length} items)</small><br><small>https://www.imdb.com/list/${id}/</small></li>`;
        }).join("")
      : "<li>(none)</li>"
  }</ul>
  <p><small>Last sync: ${LAST_SYNC_AT ? (new Date(LAST_SYNC_AT).toLocaleString() + " (" + Math.round((Date.now()-LAST_SYNC_AT)/60000) + " min ago)") : "never"}</small></p>
  <div class="row">
    <form method="POST" action="/api/sync?admin=${encodeURIComponent(ADMIN_PASSWORD)}">
      <button class="btn2">Sync IMDb Lists Now</button>
    </form>
    <span><small>Auto-sync every ${IMDB_SYNC_MINUTES} min.</small></span>
  </div>
</div>

<div class="card">
  <h3>Customize (enable/disable, order, defaults)</h3>
  <p>Drag rows to change order. First enabled row becomes default unless you pick one below.</p>
  <div class="row"><b>Default list:</b> <select id="defaultList"></select>
    <label style="margin-left:12px"><input type="checkbox" id="upgradeEp"> Upgrade episodes to parent series</label>
  </div>
  <table id="tbl">
    <thead><tr><th>Enabled</th><th>List (lsid)</th><th>Items</th><th>Default sort</th></tr></thead>
    <tbody>${rows || ""}</tbody>
  </table>
  <div class="row" style="margin-top:10px">
    <button id="saveBtn">Save</button>
  </div>
  <p id="msg" style="color:#2d6cdf"></p>
</div>

<div class="card">
  <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
  <ul>${disc}</ul>
  <p><small>Debug: <a target="_blank" href="/admin/debug?url=${encodeURIComponent(IMDB_USER_URL)}&admin=${encodeURIComponent(ADMIN_PASSWORD)}">open</a> (shows the first part of HTML we receive)</small></p>
</div>

<div class="card">
  <h3>Manifest URL</h3>
  <p class="code">${manifestUrl}</p>
  <p><small>Version bumps automatically when catalogs change.</small></p>
</div>

<script>
const prefs = ${JSON.stringify(PREFS)};
const lists = ${JSON.stringify(LISTS)};
(function init(){
  const order = prefs.order && prefs.order.length ? prefs.order.slice() : Object.keys(lists);
  const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));

  const dl = document.getElementById("defaultList");
  order.forEach(lsid=>{
    const o = document.createElement("option");
    o.value = lsid; o.textContent = lists[lsid]?.name || lsid;
    if (lsid === prefs.defaultList) o.selected = true;
    dl.appendChild(o);
  });

  document.getElementById("upgradeEp").checked = !!prefs.upgradeEpisodes;

  const tbody = document.querySelector("#tbl tbody");
  // hydrate controls state
  tbody.querySelectorAll("tr").forEach(tr=>{
    const lsid = tr.getAttribute("data-id");
    const cb = tr.querySelector("input.en");
    cb.checked = enabledSet.has(lsid);
    const sel = tr.querySelector("select.sort");
    sel.value = (prefs.perListSort && prefs.perListSort[lsid]) || "name_asc";
  });

  // drag&drop
  let dragEl = null;
  tbody.addEventListener("dragstart", e=>{
    const tr = e.target.closest("tr");
    if (!tr) return;
    dragEl = tr; tr.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  tbody.addEventListener("dragend", e=>{
    if (dragEl) dragEl.classList.remove("dragging");
    dragEl = null;
  });
  tbody.addEventListener("dragover", e=>{
    e.preventDefault();
    const afterEl = Array.from(tbody.querySelectorAll("tr:not(.dragging)"))
      .find(row => e.clientY <= row.getBoundingClientRect().top + row.offsetHeight/2);
    const dragging = tbody.querySelector(".dragging");
    if (!dragging) return;
    if (!afterEl) tbody.appendChild(dragging);
    else tbody.insertBefore(dragging, afterEl);
  });

  document.getElementById("saveBtn").onclick = async ()=>{
    // collect order & prefs
    const newOrder = Array.from(tbody.querySelectorAll("tr")).map(tr => tr.getAttribute("data-id"));
    const newEnabled = Array.from(tbody.querySelectorAll("tr")).filter(tr => tr.querySelector("input.en").checked).map(tr=>tr.getAttribute("data-id"));
    const newPerSort = {};
    tbody.querySelectorAll("tr").forEach(tr=>{
      const lsid = tr.getAttribute("data-id");
      newPerSort[lsid] = tr.querySelector("select.sort").value;
    });

    const body = {
      enabled: newEnabled,
      order: newOrder,
      defaultList: dl.value || "",
      perListSort: newPerSort,
      upgradeEpisodes: document.getElementById("upgradeEp").checked
    };
    document.getElementById("msg").textContent = "Saving…";
    const r = await fetch("/api/prefs?admin=${encodeURIComponent(ADMIN_PASSWORD)}", {
      method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body)
    });
    const t = await r.text();
    document.getElementById("msg").textContent = t || "Saved.";
    setTimeout(()=>{ document.getElementById("msg").textContent = ""; }, 2500);
  };
})();
</script>
</body></html>`);
});

// debug viewer
app.get("/admin/debug", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const url = req.query.url;
    if (!url) return res.status(400).send("url param required");
    const html = await fetchImdbHtml(url);
    res.type("text/plain").send(html.slice(0, 5000));
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// lists/prefs APIs
app.get("/api/lists", (req,res)=>{ if (!adminAllowed(req)) return res.status(403).send("Forbidden"); res.json(LISTS); });
app.get("/api/prefs", (req,res)=>{ if (!adminAllowed(req)) return res.status(403).send("Forbidden"); res.json(PREFS); });

app.post("/api/prefs", (req,res)=>{
  (async ()=>{
    if (!adminAllowed(req)) return res.status(403).send("Forbidden");
    try {
      const body = req.body || {};
      PREFS.enabled         = Array.isArray(body.enabled) ? body.enabled.filter(isList) : [];
      PREFS.order           = Array.isArray(body.order)   ? body.order.filter(isList) : [];
      PREFS.defaultList     = isList(body.defaultList) ? body.defaultList : "";
      PREFS.perListSort     = body.perListSort && typeof body.perListSort === "object" ? body.perListSort : {};
      PREFS.upgradeEpisodes = !!body.upgradeEpisodes;

      const mk = manifestKey();
      if (mk !== LAST_MANIFEST_KEY) {
        LAST_MANIFEST_KEY = mk;
        MANIFEST_REV++;
      }
      res.status(200).send("Saved. Manifest rev " + MANIFEST_REV);
    } catch (e) {
      console.error("prefs save error:", e);
      res.status(500).send("Failed to save");
    }
  })();
});

app.post("/api/sync", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    await fullSync({ rediscover: true });
    scheduleSync(true);
    res.status(200).send(`Synced at ${new Date().toISOString()}. <a href="/admin?admin=${encodeURIComponent(ADMIN_PASSWORD)}">Back</a>`);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// ----------------- BOOT -----------------
(async ()=>{
  await fullSync({ rediscover: true });
  scheduleSync(false);
  app.listen(PORT, HOST, ()=>{
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
  });
})();
