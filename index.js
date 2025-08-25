// My Lists add-on (CSV + IMDb auto-sync) with Admin UI
// - CSVs in GitHub (unchanged)
// - Auto & manual sync from IMDb lists (either IMDB_USER_URL for all lists, or IMDB_LISTS for specific ones)
// - Lean catalogs: hydrate only the current page for speed

const express = require("express");
const multer = require("multer");
const { parse } = require("csv-parse/sync");

// ---- env ----
const PORT = Number(process.env.PORT) || 7000;
const HOST = "0.0.0.0";

// Secrets
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";

// GitHub (CSV storage)
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN  || "";
const GITHUB_OWNER   = process.env.GITHUB_OWNER  || "";
const GITHUB_REPO    = process.env.GITHUB_REPO   || "";
const GITHUB_BRANCH  = process.env.GITHUB_BRANCH || "main";
const CSV_DIR        = process.env.CSV_DIR       || "data";

// IMDb sync
const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g., https://www.imdb.com/user/ur136127821/lists/
const IMDB_LISTS_JSON   = process.env.IMDB_LISTS || "[]";  // optional JSON array of {name,url,type}
const IMDB_SYNC_MINUTES = Number(process.env.IMDB_SYNC_MINUTES || 60);

// sanity hints
if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) console.warn("WARNING: Set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO.");
if (!ADMIN_PASSWORD) console.warn("WARNING: ADMIN_PASSWORD missing; /admin unusable.");

// ---- helpers ----
const CINEMETA = "https://v3-cinemeta.strem.io";
const looksSeries = (name) => /series|tv|show|shows|season|episodes/i.test(name || "");
const isImdb = (v) => /^tt\d{7,}$/i.test(String(v || ""));
const toTs = (dateStr, year) => {
  if (dateStr) { const t = Date.parse(dateStr); if (!Number.isNaN(t)) return t; }
  if (year)    { const t = Date.parse(`${year}-01-01`); if (!Number.isNaN(t)) return t; }
  return null;
};

// ---- in-memory state ----
let LISTS = {};                       // { name: { source:'csv'|'imdb', kind:'movie'|'series', items:[{id,name?,year?,releaseDate?}] } }
const PREFERRED_KIND = new Map();     // imdbId -> 'movie'|'series'
const metaCache = new Map();          // `${kind}:${tt}` -> meta | null

// tiny fetch
async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html,*/*" } });
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return r.text();
}

// ---- GitHub Contents API ----
async function ghRequest(method, path, body) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`GitHub ${method} ${path} -> ${r.status}: ${t}`);
  }
  return r.json();
}
async function ghListCSVs() {
  const path = `/contents/${encodeURIComponent(CSV_DIR)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  try {
    const data = await ghRequest("GET", path);
    return (Array.isArray(data) ? data : []).filter((f) => f.type === "file" && /\.csv$/i.test(f.name));
  } catch (e) { if (String(e.message).includes("404")) return []; throw e; }
}
async function ghGetFileSha(relpath) {
  try { const data = await ghRequest("GET", `/contents/${encodeURIComponent(relpath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`); return data.sha; }
  catch { return null; }
}
async function ghPutCSV(filename, base64Content) {
  const rel = `${CSV_DIR}/${filename}`;
  const sha = await ghGetFileSha(rel);
  const body = { message: `Upload ${filename}`, content: base64Content, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  return ghRequest("PUT", `/contents/${encodeURIComponent(rel)}`, body);
}

// ---- Cinemeta ----
async function fetchCinemeta(kind, imdbId) {
  if (!isImdb(imdbId)) return null;
  const key = `${kind}:${imdbId}`;
  if (metaCache.has(key)) return metaCache.get(key);
  try {
    const r = await fetch(`${CINEMETA}/meta/${encodeURIComponent(kind)}/${encodeURIComponent(imdbId)}.json`);
    if (!r.ok) throw new Error("cinemeta");
    const { meta } = await r.json();
    metaCache.set(key, meta);
    return meta;
  } catch {
    metaCache.set(key, null);
    return null;
  }
}
async function ensureMetaAny(prefKind, imdbId) {
  let meta = await fetchCinemeta(prefKind, imdbId);
  let kind = prefKind;
  if (!meta) {
    const other = prefKind === "movie" ? "series" : "movie";
    meta = await fetchCinemeta(other, imdbId);
    if (meta) kind = other;
  }
  return { meta, kind };
}

// ---- CSV loader ----
async function loadCSVLists() {
  const files = await ghListCSVs();
  const lists = {};
  for (const f of files) {
    const listName = f.name.replace(/\.csv$/i, "");
    const kind = looksSeries(listName) ? "series" : "movie";
    const raw = await fetchText(f.download_url);
    const rows = parse(raw, { columns: true, skip_empty_lines: true });

    const items = rows.map((r) => {
      const imdbId = String(r.Const || "").trim();
      if (isImdb(imdbId)) PREFERRED_KIND.set(imdbId, kind);
      return {
        id: imdbId || `local:${r.Title || "Untitled"}:${r.Year || ""}`,
        type: kind,
        name: (r.Title || "").trim() || undefined,
        year: r.Year ? Number(r.Year) : undefined,
        releaseDate: r["Release Date"] || undefined,
      };
    });
    lists[listName] = { source: "csv", kind, items };
  }
  return lists;
}

// ---- IMDb loader (public lists) ----
function parseImdbListsEnv() {
  try { const arr = JSON.parse(IMDB_LISTS_JSON); return Array.isArray(arr) ? arr.filter(x => x && x.name && x.url && x.type) : []; }
  catch { return []; }
}
// discover list URLs + names from a user lists page
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(userListsUrl);
  // links like /list/ls0123456789/
  const re = /href="\/list\/(ls\d{6,})\/[^"]*".*?>([^<]+)</gi;
  const found = new Map();
  let m;
  while ((m = re.exec(html))) {
    const id = m[1]; const name = m[2].trim();
    const url = `https://www.imdb.com/list/${id}/`;
    if (!found.has(id)) found.set(id, { name, url, type: looksSeries(name) ? "series" : "movie" });
  }
  return Array.from(found.values());
}
function addUniqueInOrder(arr, seen, id) { if (!seen.has(id)) { seen.add(id); arr.push(id); } }
function extractTconstsFromHtml(html) {
  const out = []; const seen = new Set();
  const re1 = /data-tconst="(tt\d{7,})"/gi; let m1;
  while ((m1 = re1.exec(html))) addUniqueInOrder(out, seen, m1[1]);
  const re2 = /\/title\/(tt\d{7,})/gi; let m2;
  while ((m2 = re2.exec(html))) addUniqueInOrder(out, seen, m2[1]);
  return out;
}
async function fetchImdbListIdsAllPages(listUrl, maxPages = 15) {
  const base = new URL(listUrl);
  const all = []; const seen = new Set();
  for (let p = 1; p <= maxPages; p++) {
    base.searchParams.set("page", String(p));
    let html; try { html = await fetchText(base.toString()); } catch { break; }
    const ids = extractTconstsFromHtml(html);
    let added = 0; for (const tt of ids) if (!seen.has(tt)) { seen.add(tt); all.push(tt); added++; }
    if (ids.length === 0 || added === 0) break;
  }
  return all;
}
async function loadIMDbLists() {
  // Prefer explicit IMDB_LISTS; otherwise discover from IMDB_USER_URL
  let cfg = parseImdbListsEnv();
  if ((!cfg || cfg.length === 0) && IMDB_USER_URL) {
    try { cfg = await discoverListsFromUser(IMDB_USER_URL); }
    catch (e) { console.warn("IMDb user discovery failed:", e.message); cfg = []; }
  }
  const lists = {};
  for (const { name, url, type } of cfg) {
    const kind = (String(type).toLowerCase().includes("series")) ? "series" : "movie";
    const ids = await fetchImdbListIdsAllPages(url).catch(() => []);
    const items = ids.map(tt => ({ id: tt, type: kind }));
    for (const tt of ids) PREFERRED_KIND.set(tt, kind);
    lists[name] = { source: "imdb", kind, items };
  }
  return lists;
}

// ---- master reload: CSV + IMDb ----
async function reloadAllSources() {
  PREFERRED_KIND.clear();
  const [csvLists, imdbLists] = await Promise.all([
    loadCSVLists().catch(e => { console.warn("CSV load failed:", e.message); return {}; }),
    loadIMDbLists().catch(e => { console.warn("IMDb load failed:", e.message); return {}; })
  ]);
  LISTS = { ...csvLists, ...imdbLists }; // IMDb overrides name collision
  const labels = Object.entries(LISTS).map(([k,v]) => `${k} (${v.kind}, ${v.source})`);
  console.log("Loaded lists:", labels.join(", ") || "(none)");
}

// initial load on boot
reloadAllSources().catch((e) => console.warn("Initial load failed:", e.message));

// periodic IMDb refresh (non-blocking)
if (IMDB_SYNC_MINUTES > 0) {
  setInterval(async () => {
    try { const imdbOnly = await loadIMDbLists(); LISTS = { ...LISTS, ...imdbOnly }; console.log("IMDb lists refreshed", new Date().toISOString()); }
    catch (e) { console.warn("IMDb refresh error:", e.message); }
  }, IMDB_SYNC_MINUTES * 60 * 1000);
}

// ---- Manifest ----
const baseManifest = {
  id: "org.my.csvlists",
  version: "6.1.0",
  name: "My Lists",
  description: "Your CSV/IMDb lists under one section; opens real movie/series pages so streams load.",
  resources: ["catalog", "meta"],
  types: ["my lists", "movie", "series"],
  idPrefixes: ["tt"]
};
function catalogs() {
  return Object.keys(LISTS).map((name) => ({
    type: "My lists",
    id: `list:${name}`,
    name: `🗂 ${name}`,
    extraSupported: ["search", "skip", "limit", "sort"],
    extra: [
      { name: "search" }, { name: "skip" }, { name: "limit" },
      { name: "sort", options: ["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"] }
    ],
    posterShape: "poster"
  }));
}

// ---- Express app ----
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
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

// ---- HEALTH ----
app.get("/health", (_, res) => res.status(200).send("ok"));

// ---- MANIFEST ----
app.get("/manifest.json", (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    res.json({ ...baseManifest, catalogs: catalogs() });
  } catch (e) { console.error("Manifest error:", e); res.status(500).send("Internal Server Error"); }
});

// ---- utils ----
function parseExtra(extraStr, queryObj) {
  const params = new URLSearchParams(extraStr || ""); const fromPath = Object.fromEntries(params.entries());
  return { ...fromPath, ...(queryObj || {}) };
}
function snapshotFromCache(prefKind, item) {
  const snap = { id: item.id, type: item.type || prefKind, name: item.name, year: item.year, releaseDate: item.releaseDate };
  const a = metaCache.get(`movie:${item.id}`), b = metaCache.get(`series:${item.id}`); const cm = a || b;
  if (cm) {
    snap.type = cm.type || snap.type; snap.name = cm.name || snap.name;
    snap.imdbRating = cm.imdbRating ?? cm.rating ?? snap.imdbRating;
    snap.runtime = cm.runtime ?? snap.runtime;
    snap.poster = cm.poster || snap.poster; snap.background = cm.background || snap.background; snap.logo = cm.logo || snap.logo;
    snap.year = snap.year ?? cm.year; snap.releaseDate = snap.releaseDate ?? cm.releaseInfo ?? cm.released;
  }
  return snap;
}
function stableSort(items, sort) {
  const s = String(sort || "name_asc").toLowerCase(); const dir = s.endsWith("_asc") ? 1 : -1; const key = s.split("_")[0];
  const cmpNullBottom = (va, vb) => { const na = (va==null), nb = (vb==null); if (na && nb) return 0; if (na) return 1; if (nb) return -1; return va < vb ? -1 : va > vb ? 1 : 0; };
  return [...items].map((m,i)=>({m,i})).sort((A,B)=>{
    const a=A.m,b=B.m; let c=0;
    if (key==="date") c = cmpNullBottom(toTs(a.releaseDate, a.year), toTs(b.releaseDate, b.year));
    else if (key==="rating") c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
    else if (key==="runtime") c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
    else { c = (a.name||"").localeCompare(b.name||""); }
    if (c===0){ c=(a.name||"").localeCompare(b.name||""); if(c===0) c=(a.id||"").localeCompare(b.id||""); if(c===0) c=A.i-B.i; }
    return c*dir;
  }).map(x=>x.m);
}

// ---- CATALOG ----
app.get("/catalog/:type/:id/:extra?.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    const { id } = req.params;
    if (!id?.startsWith("list:")) return res.json({ metas: [] });

    const listName = id.slice(5);
    const list = LISTS[listName];
    if (!list) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q = String(extra.search || "").toLowerCase().trim();
    const sort = String(extra.sort || "name_asc").toLowerCase();
    const skip = Math.max(0, Number(extra.skip || 0));
    const limit = Math.min(Number(extra.limit || 100), 200);

    // Snapshots from cache (no network)
    let snaps = (list.items || []).map(it => snapshotFromCache(list.kind, it));

    // search
    if (q) snaps = snaps.filter(m =>
      (m.name || "").toLowerCase().includes(q) || (m.id || "").toLowerCase().includes(q)
    );

    // sort
    snaps = stableSort(snaps, sort);

    // page
    let page = snaps.slice(skip, skip + limit);

    // hydrate only this page (fetch Cinemeta as needed)
    await Promise.all(page.map(async (m, idx) => {
      if (!isImdb(m.id)) return;
      const need = !m.name || !m.poster || m.imdbRating == null || m.runtime == null || !m.year;
      if (!need) return;
      const pref = PREFERRED_KIND.get(m.id) || list.kind || "movie";
      const { meta, kind } = await ensureMetaAny(pref, m.id);
      if (meta) {
        page[idx] = {
          ...m, type: kind,
          name: meta.name || m.name || m.id,
          poster: meta.poster || m.poster, background: meta.background || m.background, logo: meta.logo || m.logo,
          imdbRating: meta.imdbRating ?? meta.rating ?? m.imdbRating,
          runtime: meta.runtime ?? m.runtime,
          year: m.year ?? meta.year,
          releaseDate: m.releaseDate ?? meta.releaseInfo ?? meta.released
        };
      } else { page[idx] = { ...m, name: m.name || m.id }; }
    }));

    res.json({ metas: page });
  } catch (e) { console.error("Catalog error:", e); res.status(500).send("Internal Server Error"); }
});

// ---- META ----
app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    const imdbId = req.params.id;
    if (!isImdb(imdbId)) return res.json({ meta: { id: imdbId, type: "movie", name: "Unknown item" } });

    const pref = PREFERRED_KIND.get(imdbId) || "movie";
    const { meta, kind } = await ensureMetaAny(pref, imdbId);
    if (!meta) return res.json({ meta: { id: imdbId, type: kind } });
    res.json({ meta: { ...meta, id: imdbId, type: kind } });
  } catch (e) { console.error("Meta error:", e); res.status(500).send("Internal Server Error"); }
});

// ---- ADMIN UI ----
function absoluteBase(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

app.get("/admin", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  let files = []; try { files = await ghListCSVs(); } catch (_) {}
  const list = files.map((f) => `<li>${f.name}</li>`).join("") || "<li>(none yet)</li>";
  const manifestUrl = `${absoluteBase(req)}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;

  // Show IMDb config & discovered lists
  const explicit = parseImdbListsEnv();
  let imdbSection = "";
  if (explicit.length) {
    imdbSection = `<ul>${explicit.map(x=>`<li><b>${x.name}</b> <small>(${x.type})</small><br/><small>${x.url}</small></li>`).join("")}</ul>`;
  } else if (IMDB_USER_URL) {
    try {
      const discovered = await discoverListsFromUser(IMDB_USER_URL);
      imdbSection = discovered.length
        ? `<p><small>Discovered from <span class="code">${IMDB_USER_URL}</span>:</small></p>
           <ul>${discovered.map(x=>`<li><b>${x.name}</b> <small>(${x.type})</small><br/><small>${x.url}</small></li>`).join("")}</ul>`
        : `<p><small>No public lists found at <span class="code">${IMDB_USER_URL}</span>.</small></p>`;
    } catch { imdbSection = `<p><small>Couldn’t fetch <span class="code">${IMDB_USER_URL}</span>.</small></p>`; }
  } else {
    imdbSection = `<p><small>Configure either <span class="code">IMDB_LISTS</span> or <span class="code">IMDB_USER_URL</span>.</small></p>`;
  }

  res.type("html").send(`
<!doctype html>
<html>
<head>
<title>My Lists Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:760px}
h1{margin:0 0 16px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
label{display:block;margin:8px 0 4px}
input[type=text]{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px}
button{padding:10px 16px;border:0;border-radius:8px;background:#6c5ce7;color:#fff;cursor:pointer}
ul{padding-left:18px}
small{color:#666}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}
.btn2{background:#2d6cdf}
</style>
</head>
<body>
  <h1>My Lists – Admin</h1>

  <div class="card">
    <h3>Upload CSV</h3>
    <form method="POST" action="/api/upload?admin=${ADMIN_PASSWORD}" enctype="multipart/form-data">
      <label>List Name (filename, e.g. <span class="code">Marvel_Movies</span>)</label>
      <input type="text" name="name" placeholder="Marvel_Movies" required />
      <label>CSV file</label>
      <input type="file" name="file" accept=".csv" required />
      <p><small>If filename contains “series”, it is treated as a Series list.</small></p>
      <button type="submit">Upload & Save</button>
    </form>
  </div>

  <div class="card">
    <h3>Current CSVs in GitHub</h3>
    <ul>${list}</ul>
    <form method="POST" action="/api/reload?admin=${ADMIN_PASSWORD}">
      <button>Reload Add-on Now</button>
    </form>
  </div>

  <div class="card">
    <h3>IMDb Lists</h3>
    ${imdbSection}
    <form method="POST" action="/api/sync-imdb?admin=${ADMIN_PASSWORD}">
      <button class="btn2">Sync IMDb Lists Now</button>
    </form>
    <p><small>Auto-sync every ${IMDB_SYNC_MINUTES} min${IMDB_SYNC_MINUTES ? "" : " (disabled)"}.</small></p>
  </div>

  <div class="card">
    <h3>Manifest URL</h3>
    <p>Install in Stremio via:</p>
    <p class="code">${manifestUrl}</p>
  </div>
</body>
</html>`);
});

// Upload & reload
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    if (!req.file) return res.status(400).send("Missing file");
    const nameInput = String(req.body.name || "").trim().replace(/[^A-Za-z0-9_\-]/g, " ");
    if (!nameInput) return res.status(400).send("Bad name");
    const filename = `${nameInput}.csv`;
    const base64 = Buffer.from(req.file.buffer).toString("base64");
    await ghPutCSV(filename, base64);
    await reloadAllSources();
    res.status(200).send(`Uploaded ${filename} and reloaded. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  } catch (e) { console.error(e); res.status(500).send(String(e)); }
});
app.post("/api/reload", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try { await reloadAllSources(); res.status(200).send(`Reloaded. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`); }
  catch (e) { console.error(e); res.status(500).send(String(e)); }
});
app.post("/api/sync-imdb", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try { const imdbOnly = await loadIMDbLists(); LISTS = { ...LISTS, ...imdbOnly }; res.status(200).send(`IMDb lists synced. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`); }
  catch (e) { console.error(e); res.status(500).send(String(e)); }
});

// ---- start ----
app.listen(PORT, HOST, () => {
  console.log(`Admin: http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
});
