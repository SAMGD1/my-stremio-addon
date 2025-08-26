/* My Lists – IMDb → Stremio (stable)
 * v10.1.0
 * - Auto-discovers all public lists from IMDB_USER_URL (no manual env per list)
 * - Paginates every list; de-dupes
 * - Metadata: Cinemeta (series → movie); fallback to IMDb JSON-LD/OG
 * - Optionally upgrades episodes → parent series (default: true)
 * - Admin page with “Sync now”
 * - Manifest version uses valid semver pre-release: 10.1.0-<rev>
 */

"use strict";

const express = require("express");

// -------- ENV --------
const PORT = Number(process.env.PORT || 7000);
const HOST = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

// Behavior flags
const UPGRADE_EPISODES_TO_SERIES = String(process.env.UPGRADE_EPISODES || "true").toLowerCase() !== "false";

// -------- CONSTANTS / STATE --------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/10.1";
const CINEMETA = "https://v3-cinemeta.strem.io";

/** { [lsid]: { id, name, url, ids: string[] } } */
let LISTS = Object.create(null);

// Caches
/** Map<tt, {kind:'movie'|'series'|null, meta:object|null}> */
const BEST = new Map();
/** Map<tt, { name?, poster?, releaseDate?, year?, type? }> */
const FALLBACK = new Map();
/** Map<episode_tt, series_tt> */
const EP2SER = new Map();

let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;
let MANIFEST_REV = 1;   // bump to make Stremio refresh
let LAST_MANIFEST_KEY = "";

// -------- tiny helpers --------
const isImdb = (v) => /^tt\d{7,}$/i.test(String(v || ""));
const isListId = (v) => /^ls\d{6,}$/i.test(String(v || ""));
const minutes = (ms) => Math.round(ms / 60000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchText(url, accept) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": accept || "text/html,*/*" } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}
const withParam = (u, k, v) => { const x = new URL(u); x.searchParams.set(k, v); return x.toString(); };

// -------- IMDb discovery / parsing --------
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(withParam(userListsUrl, "_", Date.now()), "text/html");
  // links like: /list/ls##########/
  const re = /href="\/list\/(ls\d{6,})\/"/gi;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ id, url: `https://www.imdb.com/list/${id}/` });
    }
  }
  // resolve names quickly
  for (const L of out) {
    try { L.name = await fetchListName(L.url); }
    catch { L.name = L.id; }
  }
  return out;
}
async function fetchListName(listUrl) {
  const html = await fetchText(withParam(listUrl, "_", Date.now()), "text/html");
  const patterns = [
    /<h1[^>]+data-testid="list-header-title"[^>]*>(.*?)<\/h1>/i,
    /<h1[^>]*class="[^"]*header[^"]*"[^>]*>(.*?)<\/h1>/i,
    /<title>(.*?)<\/title>/i
  ];
  for (const rx of patterns) {
    const m = html.match(rx);
    if (m) return m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  }
  return listUrl;
}
function tconstsFromHtml(html) {
  const out = []; const seen = new Set(); let m;
  const re1 = /data-tconst="(tt\d{7,})"/gi;
  while ((m = re1.exec(html))) { if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); } }
  const re2 = /\/title\/(tt\d{7,})\//gi;
  while ((m = re2.exec(html))) { if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); } }
  return out;
}
function nextPageUrl(html) {
  let m = html.match(/<a[^>]+rel="next"[^>]+href="([^"]+)"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*lister-page-next[^"]*"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*data-testid="pagination-next-page-button"[^>]*>/i);
  if (!m) return null;
  try { return new URL(m[1], "https://www.imdb.com").toString(); } catch { return null; }
}
async function fetchImdbListIdsAllPages(listUrl, maxPages = 60) {
  const modes = ["detail", "grid", "compact"];
  const seen = new Set(); const ids = [];
  for (const mode of modes) {
    let url = withParam(listUrl, "mode", mode);
    let pages = 0;
    while (url && pages < maxPages) {
      let html; try { html = await fetchText(withParam(url, "_", Date.now()), "text/html"); } catch { break; }
      const found = tconstsFromHtml(html);
      let added = 0;
      for (const tt of found) if (!seen.has(tt)) { seen.add(tt); ids.push(tt); added++; }
      pages++;
      if (!added) break;
      url = nextPageUrl(html);
    }
    if (ids.length) break;
  }
  return ids;
}

// -------- Cinemeta / metadata --------
async function fetchCinemeta(kind, imdbId) {
  try {
    const j = await fetchJson(`${CINEMETA}/meta/${encodeURIComponent(kind)}/${encodeURIComponent(imdbId)}.json`);
    return j && j.meta ? j.meta : null;
  } catch { return null; }
}
async function imdbJsonLd(imdbId) {
  try {
    const html = await fetchText(`https://www.imdb.com/title/${imdbId}/`, "text/html");
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (m) { try { return JSON.parse(m[1]); } catch {} }
    // small OG fallback
    const t = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    const p = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
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

// Prefer series first, then movie (prevents many mis-typed shows)
async function getBestMeta(imdbId) {
  if (BEST.has(imdbId)) return BEST.get(imdbId);

  let meta = await fetchCinemeta("series", imdbId);
  if (meta) { const rec = { kind: "series", meta }; BEST.set(imdbId, rec); return rec; }

  meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind: "movie", meta }; BEST.set(imdbId, rec); return rec; }

  // Last-resort: IMDb LD (and mark plausible type)
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
function toTs(d, y) {
  if (d) { const t = Date.parse(d); if (!Number.isNaN(t)) return t; }
  if (y) { const t = Date.parse(`${y}-01-01`); if (!Number.isNaN(t)) return t; }
  return null;
}
function stableSort(items, sort) {
  const s = String(sort || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const key = s.split("_")[0];

  const cmpNullBottom = (a, b) => {
    const na = a == null, nb = b == null;
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  return items.map((m, i) => ({ m, i })).sort((A, B) => {
    const a = A.m, b = B.m;
    let c = 0;
    if (key === "date") c = cmpNullBottom(toTs(a.releaseDate, a.year), toTs(b.releaseDate, b.year));
    else if (key === "rating") c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
    else if (key === "runtime") c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
    else c = (a.name || "").localeCompare(b.name || "");
    if (c === 0) {
      c = (a.name || "").localeCompare(b.name || "");
      if (c === 0) c = (a.id || "").localeCompare(b.id || "");
      if (c === 0) c = A.i - B.i;
    }
    return c * dir;
  }).map(x => x.m);
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

// -------- SYNC --------
async function fullSync({ rediscover = true } = {}) {
  if (syncInProgress) return;
  syncInProgress = true;
  const started = Date.now();
  try {
    // 1) discover
    let discovered = [];
    if (IMDB_USER_URL && rediscover) {
      try { discovered = await discoverListsFromUser(IMDB_USER_URL); }
      catch (e) { console.warn("[SYNC] discovery failed:", e.message); }
    }

    // Merge with what we had (IMDb sometimes hiccups)
    const next = Object.create(null);
    const toFetch = [];

    const seen = new Set();
    for (const d of discovered) {
      next[d.id] = { id: d.id, name: d.name || d.id, url: d.url, ids: [] };
      toFetch.push(d.id);
      seen.add(d.id);
    }
    for (const id of Object.keys(LISTS)) {
      if (!seen.has(id)) next[id] = LISTS[id]; // keep old if not rediscovered
      if (!next[id].ids || !next[id].ids.length) toFetch.push(id);
    }

    // 2) fetch items per list
    const unique = new Set();
    for (const id of Object.keys(next)) {
      const url = next[id].url || `https://www.imdb.com/list/${id}/`;
      let ids = [];
      try { ids = await fetchImdbListIdsAllPages(url); } catch {}
      next[id].ids = ids;
      ids.forEach(tt => unique.add(tt));
      // be gentle (IMDb can rate-limit)
      await sleep(100);
    }

    // 3) upgrade episodes → series (optional)
    let idsToPreload = Array.from(unique);
    if (UPGRADE_EPISODES_TO_SERIES) {
      const upgraded = new Set();
      for (const tt of idsToPreload) {
        // quick probe; if Cinemeta has either movie/series we keep it; otherwise check LD for episode parent
        const rec = await getBestMeta(tt);
        if (!rec.meta) {
          const ser = await episodeParentSeries(tt);
          upgraded.add(ser && isImdb(ser) ? ser : tt);
        } else {
          upgraded.add(tt);
        }
      }
      idsToPreload = Array.from(upgraded);

      // remap each list ids and de-dupe
      for (const id of Object.keys(next)) {
        const remapped = [];
        const seen2 = new Set();
        for (const tt of next[id].ids) {
          let final = tt;
          const r = BEST.get(tt);
          if (!r || !r.meta) {
            const ser = await episodeParentSeries(tt);
            if (ser) final = ser;
          }
          if (!seen2.has(final)) { seen2.add(final); remapped.push(final); }
        }
        next[id].ids = remapped;
      }
    }

    // 4) preload metas in parallel (limit)
    await mapLimit(idsToPreload, 8, getBestMeta);

    LISTS = next;
    LAST_SYNC_AT = Date.now();

    // bump manifest if the “shape” changed
    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) {
      LAST_MANIFEST_KEY = key;
      MANIFEST_REV++;
      console.log("[SYNC] catalogs changed → manifest rev", MANIFEST_REV);
    }

    console.log(`[SYNC] ok – ${idsToPreload.length} ids across ${Object.keys(LISTS).length} lists in ${minutes(Date.now()-started)} min`);
  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    syncInProgress = false;
  }
}
function scheduleNextSync(reset) {
  if (syncTimer) clearTimeout(syncTimer);
  if (IMDB_SYNC_MINUTES <= 0) return;
  const delay = IMDB_SYNC_MINUTES * 60 * 1000;
  syncTimer = setTimeout(async () => {
    await fullSync({ rediscover: true });
    scheduleNextSync(true);
  }, delay);
}
function maybeBackgroundSync() {
  if (IMDB_SYNC_MINUTES <= 0) return;
  const tooOld = Date.now() - LAST_SYNC_AT > IMDB_SYNC_MINUTES * 60 * 1000;
  if (tooOld && !syncInProgress) fullSync({ rediscover: true }).then(() => scheduleNextSync(true));
}
function manifestKey() {
  const ids = Object.keys(LISTS).sort().join(",");
  const names = Object.keys(LISTS).map(id => LISTS[id]?.name || id).sort().join("|");
  return ids + "#" + names;
}

// -------- server --------
const app = express();
app.use((_, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });

function addonAllowed(req) {
  if (!SHARED_SECRET) return true;
  const url = new URL(req.originalUrl, `http://${req.headers.host}`);
  return url.searchParams.get("key") === SHARED_SECRET;
}
function adminAllowed(req) {
  const url = new URL(req.originalUrl, `http://${req.headers.host}`);
  return (url.searchParams.get("admin") || req.headers["x-admin-key"]) === ADMIN_PASSWORD;
}
const absoluteBase = (req) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
};

app.get("/health", (_, res) => res.status(200).send("ok"));

// ---- Manifest
const baseManifest = {
  id: "org.mylists.snapshot",
  version: "10.1.0",
  name: "My Lists",
  description: "Your IMDb lists as catalogs (cached).",
  resources: ["catalog", "meta"],
  types: ["my lists", "movie", "series"],
  idPrefixes: ["tt"]
};
function catalogs() {
  return Object.keys(LISTS).sort((a,b) => {
    const na = LISTS[a]?.name || a; const nb = LISTS[b]?.name || b;
    return na.localeCompare(nb);
  }).map(lsid => ({
    type: "My lists",
    id: `list:${lsid}`,
    name: `🗂 ${LISTS[lsid]?.name || lsid}`,
    extraSupported: ["search", "skip", "limit", "sort"],
    extra: [
      { name: "search" }, { name: "skip" }, { name: "limit" },
      { name: "sort", options: ["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"] }
    ],
    posterShape: "poster"
  }));
}
app.get("/manifest.json", (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();
    const version = `${baseManifest.version}-${MANIFEST_REV}`; // valid semver w/ pre-release
    res.json({ ...baseManifest, version, catalogs: catalogs() });
  } catch (e) {
    console.error("Manifest error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ---- helpers
const parseExtra = (extraStr, qObj) => {
  const p = new URLSearchParams(extraStr || "");
  return { ...Object.fromEntries(p.entries()), ...(qObj || {}) };
};

// ---- Catalog
app.get("/catalog/:type/:id/:extra?.json", (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const { id } = req.params;
    if (!id || !id.startsWith("list:")) return res.json({ metas: [] });
    const lsid = id.slice(5);
    const list = LISTS[lsid];
    if (!list) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q     = String(extra.search || "").toLowerCase().trim();
    const sort  = String(extra.sort || "name_asc").toLowerCase();
    const skip  = Math.max(0, Number(extra.skip || 0));
    const limit = Math.min(Number(extra.limit || 100), 200);

    let metas = (list.ids || []).map(cardFor);

    if (q) {
      metas = metas.filter(m =>
        (m.name || "").toLowerCase().includes(q) ||
        (m.id || "").toLowerCase().includes(q) ||
        (m.description || "").toLowerCase().includes(q)
      );
    }

    metas = stableSort(metas, sort);
    const page = metas.slice(skip, skip + limit);
    res.json({ metas: page });
  } catch (e) {
    console.error("Catalog error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ---- Meta
app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const imdbId = req.params.id;
    if (!isImdb(imdbId))
      return res.json({ meta: { id: imdbId, type: "movie", name: "Unknown item" } });

    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);

    if (!rec || !rec.meta) {
      const fb = FALLBACK.get(imdbId) || {};
      return res.json({ meta: { id: imdbId, type: rec?.kind || fb.type || "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
    }
    res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
  } catch (e) {
    console.error("Meta error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ---- Admin
app.get("/admin", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  const base = absoluteBase(req);
  const manifestUrl = `${base}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;

  // Rediscover to display current public lists (read-only)
  let discovered = [];
  try { if (IMDB_USER_URL) discovered = await discoverListsFromUser(IMDB_USER_URL); } catch {}

  const rows = Object.keys(LISTS).map(id => {
    const L = LISTS[id]; const count = (L.ids || []).length;
    return `<li><b>${L.name || id}</b> <small>(${count} items)</small><br/><small>${L.url || ""}</small></li>`;
  }).join("") || "<li>(none)</li>";

  const disc = discovered.map(d => `<li><b>${d.name || d.id}</b><br/><small>${d.url}</small></li>`).join("") || "<li>(none found or IMDb unreachable right now).</li>";

  res.type("html").send(`<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>My Lists – Admin</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:900px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
button{padding:10px 16px;border:0;border-radius:8px;background:#2d6cdf;color:#fff;cursor:pointer}
small{color:#666}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}
.badge{display:inline-block;background:#eee;border-radius:999px;padding:2px 8px;font-size:12px;margin-left:6px}
</style></head>
<body>
<h1>My Lists – Admin</h1>

<div class="card">
  <h3>Current Snapshot</h3>
  <ul>${rows}</ul>
  <p><small>Last sync: ${LAST_SYNC_AT ? new Date(LAST_SYNC_AT).toLocaleString() + " (" + minutes(Date.now()-LAST_SYNC_AT) + " min ago)" : "never"}</small></p>
  <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}">
    <button>Sync IMDb Lists Now</button>
  </form>
  <p class="badge">Auto-sync every ${IMDB_SYNC_MINUTES} min${IMDB_SYNC_MINUTES ? "" : " (disabled)"}.</p>
</div>

<div class="card">
  <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
  <ul>${disc}</ul>
</div>

<div class="card">
  <h3>Manifest URL</h3>
  <p class="code">${manifestUrl}</p>
  <p><small>Version bumps automatically when catalogs change.</small></p>
</div>

</body></html>`);
});

app.post("/api/sync", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    await fullSync({ rediscover: true });
    scheduleNextSync(true);
    res.status(200).send(`Synced at ${new Date().toISOString()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

// ---- boot
(async () => {
  await fullSync({ rediscover: true });
  scheduleNextSync(false);
  app.listen(PORT, HOST, () => {
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
  });
})();
