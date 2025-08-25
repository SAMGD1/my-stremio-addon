/* My Lists — IMDb → Cinemeta snapshot add-on (stable)
   - Discovers public lists from IMDB_USER_URL automatically
   - Uses /export CSV for each list (most reliable), HTML as fallback
   - Prebuilds posters/titles via Cinemeta, with title-page fallback
   - Snapshots to GitHub (optional) for instant cold starts
   - Manifest auto-bumps on list-set change (no reinstall)
*/

const express = require("express");
const { parse } = require("csv-parse/sync");

// ---------- ENV ----------
const PORT = Number(process.env.PORT) || 7000;
const HOST = "0.0.0.0";

const SHARED_SECRET   = process.env.SHARED_SECRET  || "";
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD || "Stremio_172";

const IMDB_USER_URL   = process.env.IMDB_USER_URL  || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_SYNC_MIN   = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN   || "";
const GITHUB_OWNER    = process.env.GITHUB_OWNER   || "";
const GITHUB_REPO     = process.env.GITHUB_REPO    || "";
const SNAPSHOT_BRANCH = process.env.SNAPSHOT_BRANCH || "main";
const SNAPSHOT_DIR    = process.env.SNAPSHOT_DIR    || "snapshot";

const GH_ENABLED = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

// ---------- CONSTANTS ----------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyLists/Stable";
const CINEMETA = "https://v3-cinemeta.strem.io";
const SNAPSHOT_FILE = `${SNAPSHOT_DIR}/snapshot.json`;

// ---------- STATE ----------
/** LISTS[name] = { url, ids: ['tt...'] } */
let LISTS = Object.create(null);
/** FALLBACK: Map<tt, {name?:string, poster?:string}> */
const FALLBACK = new Map();
/** BEST: Map<tt, {kind:'movie'|'series'|null, meta:object|null}> */
const BEST = new Map();
/** CARDS: Map<tt, cardObject> built after sync for instant catalogs */
const CARDS = new Map();

let LAST_SYNC_AT = 0;
let MANIFEST_REV = 1;
let LAST_LISTS_KEY = "";

let syncTimer = null;
let syncing = false;

// ---------- UTILS ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isImdb = v => /^tt\d{7,}$/.test(String(v||""));
const listsKey = () => JSON.stringify(Object.keys(LISTS).sort());

async function fetchText(url, accept) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": accept || "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache"
    }
  });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "application/json", "Accept-Language": "en-US,en;q=0.9" }
  });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}

// ---------- GitHub snapshot (optional) ----------
async function ghRequest(method, path, body) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": UA
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`GitHub ${method} ${path} -> ${r.status}: ${t}`);
  }
  return r.json();
}
async function ghGetSha(path) {
  try {
    const data = await ghRequest("GET", `/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(SNAPSHOT_BRANCH)}`);
    return data && data.sha || null;
  } catch { return null; }
}
async function ghReadSnapshot() {
  if (!GH_ENABLED) return null;
  try {
    const data = await ghGetSha(SNAPSHOT_FILE);
    if (!data) return null; // file not found
    const resp = await ghRequest("GET", `/contents/${encodeURIComponent(SNAPSHOT_FILE)}?ref=${encodeURIComponent(SNAPSHOT_BRANCH)}`);
    const buf = Buffer.from(resp.content, "base64").toString("utf8");
    return JSON.parse(buf);
  } catch { return null; }
}
async function ghWriteSnapshot(obj) {
  if (!GH_ENABLED) return;
  const content = Buffer.from(JSON.stringify(obj, null, 2)).toString("base64");
  const sha = await ghGetSha(SNAPSHOT_FILE);
  const body = { message: "Update snapshot.json", content, branch: SNAPSHOT_BRANCH };
  if (sha) body.sha = sha;
  await ghRequest("PUT", `/contents/${encodeURIComponent(SNAPSHOT_FILE)}`, body);
}

// ---------- IMDb discovery & parsing ----------

/** Find list links on the user page (public lists only) */
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(userListsUrl, "text/html");
  const found = new Map();
  // Anchors like <a href="/list/ls4106685462/">Fallout Series</a>
  const re = /<a[^>]+href="\/list\/(ls\d{6,})\/"[^>]*>(.*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const raw = m[2].replace(/<[^>]+>/g, "");
    const name = raw.replace(/\s+/g, " ").trim();
    if (!found.has(id) && name) {
      found.set(id, { name, url: `https://www.imdb.com/list/${id}/` });
    }
  }
  return Array.from(found.values());
}

/** Preferred: CSV export endpoint — super stable for public lists */
async function loadListViaCSV(listUrl) {
  // ensure trailing slash before "export"
  const url = listUrl.endsWith("/") ? `${listUrl}export` : `${listUrl}/export`;
  const csv = await fetchText(url, "text/csv");
  const rows = parse(csv, { columns: true, skip_empty_lines: true });
  const items = [];
  for (const r of rows) {
    const tt = String(r.Const || "").trim();
    if (!isImdb(tt)) continue;
    items.push({ id: tt });
    // keep fallback name immediately (fast)
    if (r.Title && !FALLBACK.has(tt)) FALLBACK.set(tt, { name: r.Title });
  }
  return items;
}

/** Fallback: parse list HTML when CSV fails */
async function loadListViaHTML(listUrl) {
  const html = await fetchText(listUrl, "text/html");
  const items = [];
  const seen = new Set();

  // New UI summary items
  let re = /<li[^>]+class="[^"]*\bipc-metadata-list-summary-item\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html))) {
    const block = m[1];
    const t = block.match(/href="\/title\/(tt\d{7,})\//i);
    if (!t) continue;
    const tt = t[1];
    if (seen.has(tt)) continue;
    seen.add(tt);
    const at = block.match(/<a[^>]*>(.*?)<\/a>/i);
    const img = block.match(/<img[^>]+alt="([^"]+)"[^>]*?(?:loadlate|src)="([^"]+)"/i);
    const name = at ? at[1].replace(/<[^>]+>/g, "").trim() : (img ? img[1] : "");
    const poster = img ? img[2] : "";
    if (name || poster) {
      const prev = FALLBACK.get(tt) || {};
      FALLBACK.set(tt, { name: prev.name || name, poster: prev.poster || poster });
    }
    items.push({ id: tt });
  }

  // Classic lister blocks (extra safety)
  re = /<div[^>]+class="[^"]*\blister-item\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  while ((m = re.exec(html))) {
    const block = m[1];
    const t = block.match(/href="\/title\/(tt\d{7,})\//i);
    if (!t) continue;
    const tt = t[1];
    if (seen.has(tt)) continue;
    seen.add(tt);
    const nameMatch = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*>(.*?)<\/a>/i);
    const img = block.match(/<img[^>]+(?:loadlate|src)="([^"]+)"/i);
    const title = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, "").trim() : "";
    const poster = img ? img[1] : "";
    if (title || poster) {
      const prev = FALLBACK.get(tt) || {};
      FALLBACK.set(tt, { name: prev.name || title, poster: prev.poster || poster });
    }
    items.push({ id: tt });
  }

  return items;
}

// ---------- Cinemeta + fallbacks ----------
async function fetchCinemeta(kind, tt) {
  try {
    const r = await fetch(`${CINEMETA}/meta/${kind}/${tt}.json`, {
      headers: { "User-Agent": UA, "Accept": "application/json" }
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.meta ? j.meta : null;
  } catch { return null; }
}
async function getBestMeta(tt) {
  if (BEST.has(tt)) return BEST.get(tt);
  let meta = await fetchCinemeta("movie", tt);
  if (meta) { const rec = { kind: "movie", meta }; BEST.set(tt, rec); return rec; }
  meta = await fetchCinemeta("series", tt);
  if (meta) { const rec = { kind: "series", meta }; BEST.set(tt, rec); return rec; }
  const rec = { kind: null, meta: null };
  BEST.set(tt, rec);
  return rec;
}

/** Per-title fallback: title page JSON-LD / OpenGraph */
async function imdbTitleFallback(tt) {
  try {
    const html = await fetchText(`https://www.imdb.com/title/${tt}/`, "text/html");
    // JSON-LD first
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        const node = Array.isArray(j && j["@graph"]) ? j["@graph"][0] : j;
        const name = (node && node.name) || node && node.headline || null;
        let image = null;
        if (node && typeof node.image === "string") image = node.image;
        else if (node && node.image && node.image.url) image = node.image.url;
        return { name, poster: image || null };
      } catch { /* fallthrough */ }
    }
    const t = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    const p = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    return { name: t ? t[1] : null, poster: p ? p[1] : null };
  } catch { return { name: null, poster: null }; }
}

// ---------- Cards & sorting ----------
function buildCard(tt) {
  const rec = BEST.get(tt) || { kind: "movie", meta: null };
  const meta = rec.meta;
  const fb = FALLBACK.get(tt) || {};
  return {
    id: tt,
    type: rec.kind || "movie",
    name: (meta && meta.name) || fb.name || tt,
    poster: (meta && meta.poster) || fb.poster || undefined,
    background: meta && meta.background || undefined,
    logo: meta && meta.logo || undefined,
    imdbRating: meta && (meta.imdbRating ?? meta.rating),
    runtime: meta && meta.runtime,
    year: meta && meta.year,
    releaseDate: meta && (meta.releaseInfo ?? meta.released),
    description: meta && meta.description || undefined
  };
}
function toTs(d, y) {
  if (d) {
    const n = Date.parse(d); if (!Number.isNaN(n)) return n;
  }
  if (y) {
    const n = Date.parse(`${y}-01-01`); if (!Number.isNaN(n)) return n;
  }
  return null;
}
function stableSort(items, sortKey) {
  const s = String(sortKey || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const key = s.split("_")[0];

  const cmpNullBottom = (a, b) => {
    const na = a == null, nb = b == null;
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  return items
    .map((m, i) => ({ m, i }))
    .sort((A, B) => {
      const a = A.m, b = B.m;
      let c = 0;
      if (key === "date") c = cmpNullBottom(toTs(a.releaseDate, a.year), toTs(b.releaseDate, b.year));
      else if (key === "rating") c = cmpNullBottom(a.imdbRating, b.imdbRating);
      else if (key === "runtime") c = cmpNullBottom(a.runtime, b.runtime);
      else c = (a.name || "").localeCompare(b.name || "");
      if (c === 0) {
        c = (a.name || "").localeCompare(b.name || "");
        if (c === 0) c = (a.id || "").localeCompare(b.id || "");
        if (c === 0) c = A.i - B.i;
      }
      return c * dir;
    })
    .map(x => x.m);
}

// ---------- SYNC ----------
async function fullSync() {
  if (syncing) return;
  syncing = true;
  try {
    // 1) discover lists (keeps previous if discovery fails)
    let listsCfg = [];
    if (IMDB_USER_URL) {
      try { listsCfg = await discoverListsFromUser(IMDB_USER_URL); }
      catch (e) { console.warn("Discovery failed:", e.message); }
    }

    if (!listsCfg.length) {
      console.warn("No lists discovered (or IMDb unreachable). Keeping previous lists.");
      listsCfg = Object.keys(LISTS).map(name => ({ name, url: LISTS[name].url }));
    }

    // 2) fetch items per list (prefer CSV -> fallback HTML)
    const nextLISTS = Object.create(null);
    const allIds = new Set();

    for (const L of listsCfg) {
      let items = [];
      try { items = await loadListViaCSV(L.url); }
      catch {
        console.warn(`[CSV] failed for ${L.name}, falling back to HTML`);
        try { items = await loadListViaHTML(L.url); }
        catch (e2) { console.warn(`[HTML] failed for ${L.name}:`, e2.message); items = []; }
      }
      nextLISTS[L.name] = { url: L.url, ids: items.map(x => x.id) };
      for (const it of items) allIds.add(it.id);
      // be nice to IMDb between lists
      await sleep(250);
    }

    // 3) preload Cinemeta and build cards + title-page fallback (only during sync)
    BEST.clear(); CARDS.clear();
    const ids = Array.from(allIds);

    // limit concurrency a bit
    const workers = 8;
    let i = 0;
    await Promise.all(new Array(Math.min(workers, ids.length)).fill(0).map(async () => {
      while (i < ids.length) {
        const idx = i++;
        const tt = ids[idx];
        await getBestMeta(tt);
      }
    }));

    // build cards and backfill missing name/poster from title pages
    i = 0;
    await Promise.all(new Array(Math.min(6, ids.length)).fill(0).map(async () => {
      while (i < ids.length) {
        const idx = i++;
        const tt = ids[idx];
        let card = buildCard(tt);
        const weakName = !card.name || /^tt\d+/.test(card.name);
        const weakPoster = !card.poster;
        if (weakName || weakPoster) {
          const fb = await imdbTitleFallback(tt);
          if (fb.name && weakName) card.name = fb.name;
          if (fb.poster && weakPoster) card.poster = fb.poster;
          const prev = FALLBACK.get(tt) || {};
          FALLBACK.set(tt, { name: card.name || prev.name, poster: card.poster || prev.poster });
        }
        CARDS.set(tt, card);
        await sleep(10);
      }
    }));

    LISTS = nextLISTS;

    // 4) bump manifest if list set changed
    const key = listsKey();
    if (key !== LAST_LISTS_KEY) {
      LAST_LISTS_KEY = key;
      MANIFEST_REV++;
      console.log("[SYNC] catalogs changed → manifest rev", MANIFEST_REV);
    }

    LAST_SYNC_AT = Date.now();
    console.log(`[SYNC] ${ids.length} ids across ${Object.keys(LISTS).length} lists`);

    // 5) snapshot (optional)
    if (GH_ENABLED) {
      try {
        const snap = {
          lastSyncAt: LAST_SYNC_AT,
          manifestRev: MANIFEST_REV,
          lists: LISTS,
          fallback: Object.fromEntries(FALLBACK),
          cards: Object.fromEntries(CARDS)
        };
        await ghWriteSnapshot(snap);
        console.log("[SYNC] snapshot saved to GitHub");
      } catch (e) { console.warn("[SYNC] snapshot save failed:", e.message); }
    }

  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    syncing = false;
  }
}
function scheduleAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  if (IMDB_SYNC_MIN <= 0) return;
  syncTimer = setInterval(() => { fullSync().catch(()=>{}); }, IMDB_SYNC_MIN * 60 * 1000);
}

// ---------- SERVER ----------
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
function absoluteBase(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

app.get("/health", (_, res) => res.status(200).send("ok"));

// manifest
const baseManifest = {
  id: "org.my.csvlists",
  version: "9.2.0",
  name: "My Lists",
  description: "Your IMDb lists as instant catalogs; opens real movie/series pages so streams load.",
  resources: ["catalog", "meta"],
  types: ["my lists", "movie", "series"],
  idPrefixes: ["tt"]
};
function catalogs() {
  return Object.keys(LISTS).map((name) => ({
    type: "My lists",
    id: `list:${name}`,
    name: `🗂 ${name}`,
    extraSupported: ["search","skip","limit","sort"],
    extra: [
      { name: "search" }, { name: "skip" }, { name: "limit" },
      { name: "sort", options: ["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"] }
    ],
    posterShape: "poster"
  }));
}
app.get("/manifest.json", (req, res) => {
  if (!addonAllowed(req)) return res.status(403).send("Forbidden");
  res.setHeader("Cache-Control", "no-store");
  const version = baseManifest.version + "." + MANIFEST_REV;
  res.json({ ...baseManifest, version, catalogs: catalogs() });
});

// catalog
function parseExtra(extraStr, queryObj) {
  const params = new URLSearchParams(extraStr || "");
  const fromPath = Object.fromEntries(params.entries());
  return { ...fromPath, ...(queryObj || {}) };
}
app.get("/catalog/:type/:id/:extra?.json", (req, res) => {
  if (!addonAllowed(req)) return res.status(403).send("Forbidden");
  res.setHeader("Cache-Control", "no-store");

  const { id } = req.params;
  if (!id || !id.startsWith("list:")) return res.json({ metas: [] });

  const listName = id.slice(5);
  const list = LISTS[listName];
  if (!list || !list.ids) return res.json({ metas: [] });

  const extra = parseExtra(req.params.extra, req.query);
  const q = String(extra.search || "").toLowerCase().trim();
  const sort = String(extra.sort || "name_asc").toLowerCase();
  const skip = Math.max(0, Number(extra.skip || 0));
  const limit = Math.min(Number(extra.limit || 100), 200);

  let metas = list.ids.map(tt => {
    const c = CARDS.get(tt);
    if (c) return c;
    const fb = FALLBACK.get(tt) || {};
    return { id: tt, type: "movie", name: fb.name || tt, poster: fb.poster || undefined };
  });

  if (q) {
    metas = metas.filter(m =>
      (m.name || "").toLowerCase().includes(q) ||
      (m.description || "").toLowerCase().includes(q) ||
      (m.id || "").toLowerCase().includes(q)
    );
  }

  metas = stableSort(metas, sort);
  res.json({ metas: metas.slice(skip, skip + limit) });
});

// meta
app.get("/meta/:type/:id.json", async (req, res) => {
  if (!addonAllowed(req)) return res.status(403).send("Forbidden");
  res.setHeader("Cache-Control", "no-store");
  const tt = req.params.id;
  if (!isImdb(tt)) return res.json({ meta: { id: tt, type: "movie", name: "Unknown item" } });

  let rec = BEST.get(tt);
  if (!rec) rec = await getBestMeta(tt);

  if (!rec || !rec.meta) {
    const fb = FALLBACK.get(tt) || {};
    return res.json({ meta: { id: tt, type: (rec && rec.kind) || "movie", name: fb.name || tt, poster: fb.poster || undefined } });
  }
  res.json({ meta: { ...rec.meta, id: tt, type: rec.kind } });
});

// admin
app.get("/admin", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  const manifestUrl = `${absoluteBase(req)}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;

  const names = Object.keys(LISTS);
  const listHtml = names.length
    ? `<ul>${names.map(n => `<li><b>${n}</b> <small>(${(LISTS[n].ids||[]).length} items)</small><br/><small>${LISTS[n].url}</small></li>`).join("")}</ul>`
    : "<p>(no lists yet)</p>";

  let discoveredHtml = "<p><small>Set IMDB_USER_URL to auto-discover your lists.</small></p>";
  if (IMDB_USER_URL) {
    try {
      const discovered = await discoverListsFromUser(IMDB_USER_URL);
      discoveredHtml = discovered.length
        ? `<ul>${discovered.map(x => `<li><b>${x.name}</b><br/><small>${x.url}</small></li>`).join("")}</ul>`
        : "<p><small>No public lists found (or IMDb temporarily unreachable).</small></p>";
    } catch { /* ignore */ }
  }

  res.type("html").send(`<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
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
    ${listHtml}
    <p><small>Last sync: ${LAST_SYNC_AT ? new Date(LAST_SYNC_AT).toLocaleString() : "never"}.</small></p>
    <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}">
      <button class="btn2">Sync IMDb Lists Now</button>
    </form>
    <p><small>Auto-sync every ${IMDB_SYNC_MIN || 0} min${IMDB_SYNC_MIN ? "" : " (disabled)"}.</small></p>
    <p><small>Snapshot persistence: ${GH_ENABLED ? "GitHub enabled" : "disabled"}.</small></p>
  </div>

  <div class="card">
    <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
    ${discoveredHtml}
  </div>

  <div class="card">
    <h3>Manifest URL</h3>
    <p class="code">${manifestUrl}</p>
  </div>
</body></html>`);
});

app.post("/api/sync", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    await fullSync();
    res.status(200).send(`Synced at ${new Date().toLocaleString()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

// ---------- BOOT ----------
(async () => {
  // try to warm with snapshot (instant catalogs on cold start)
  if (GH_ENABLED) {
    try {
      const snap = await ghReadSnapshot();
      if (snap) {
        LISTS = snap.lists || Object.create(null);
        FALLBACK.clear();
        if (snap.fallback) for (const [k, v] of Object.entries(snap.fallback)) FALLBACK.set(k, v);
        CARDS.clear();
        if (snap.cards) for (const [k, v] of Object.entries(snap.cards)) CARDS.set(k, v);
        MANIFEST_REV = snap.manifestRev || 1;
        LAST_SYNC_AT = snap.lastSyncAt || 0;
        LAST_LISTS_KEY = listsKey();
        console.log("[BOOT] snapshot loaded from GitHub");
      } else {
        console.log("[BOOT] no snapshot found at GitHub");
      }
    } catch (e) {
      console.warn("[BOOT] snapshot load failed:", e.message);
    }
  }

  // kick first sync & scheduler
  fullSync().then(() => scheduleAutoSync()).catch(()=>{ scheduleAutoSync(); });

  // start server
  app.listen(PORT, HOST, () => {
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
  });
})();
