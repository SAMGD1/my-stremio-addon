// My Lists add-on with Admin UI (GitHub-backed storage)
// - One custom "My Lists" section
// - Items open as real movie/series pages so streams from other add-ons load
// - CSVs stored in your GitHub repo; uploads from /admin update the repo & auto-reload

const express = require("express");
const multer = require("multer");
const { addonBuilder } = require("stremio-addon-sdk");
const { parse } = require("csv-parse/sync");

const PORT = Number(process.env.PORT) || 7000;
const HOST = "0.0.0.0";

// ------------ security / config (set these on Render -> Environment) ------------
const SHARED_SECRET   = process.env.SHARED_SECRET   || "";         // optional
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD  || "";         // required for /admin (you said: Stremio_172)
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN    || "";         // required
const GITHUB_OWNER    = process.env.GITHUB_OWNER    || "";         // required (your GitHub username)
const GITHUB_REPO     = process.env.GITHUB_REPO     || "";         // required (repo that stores CSVs)
const GITHUB_BRANCH   = process.env.GITHUB_BRANCH   || "main";
const CSV_DIR         = process.env.CSV_DIR         || "data";

if (!ADMIN_PASSWORD) console.warn("WARNING: ADMIN_PASSWORD is not set. Set it on Render to access /admin.");
if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.warn("WARNING: GitHub env vars missing. Set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO.");
}

// ------------ helpers ------------
const CINEMETA = "https://v3-cinemeta.strem.io";
const looksSeries = (name) => /series/i.test(name || "");
const isImdb = (v) => /^tt\d+$/i.test(String(v || ""));

// memory stores
let LISTS = {};                         // { listName: { kind: 'movie'|'series', items: [...] } }
const PREFERRED_KIND = new Map();       // imdbId -> 'movie'|'series'
const metaCache = new Map();            // `${kind}:${id}` -> meta

// --------- GitHub helpers (Contents API) ----------
async function ghRequest(method, path, body) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
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
    return (Array.isArray(data) ? data : []).filter(
      (f) => f.type === "file" && /\.csv$/i.test(f.name)
    );
  } catch (e) {
    if (String(e.message).includes("404")) return []; // folder missing = empty
    throw e;
  }
}

async function ghGetFileSha(relpath) {
  try {
    const data = await ghRequest(
      "GET",
      `/contents/${encodeURIComponent(relpath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`
    );
    return data.sha;
  } catch {
    return null;
  }
}

async function ghPutCSV(filename, base64Content) {
  const rel = `${CSV_DIR}/${filename}`;
  const sha = await ghGetFileSha(rel); // include sha to update if exists
  const body = {
    message: `Upload ${filename}`,
    content: base64Content,
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  return ghRequest("PUT", `/contents/${encodeURIComponent(rel)}`, body);
}

async function fetchRaw(url) {
  const r = await fetch(url, { headers: { Accept: "text/plain" } });
  if (!r.ok) throw new Error(`raw fetch failed ${r.status}`);
  return r.text();
}

// --------- Cinemeta helpers ----------
async function fetchCinemeta(kind, imdbId) {
  if (!isImdb(imdbId)) return null;
  const key = `${kind}:${imdbId}`;
  if (metaCache.has(key)) return metaCache.get(key);
  try {
    const r = await fetch(
      `${CINEMETA}/meta/${encodeURIComponent(kind)}/${encodeURIComponent(imdbId)}.json`
    );
    if (!r.ok) throw new Error("cinemeta");
    const { meta } = await r.json();
    metaCache.set(key, meta);
    return meta;
  } catch {
    metaCache.set(key, null);
    return null;
  }
}

// --------- Load CSVs from GitHub ---------
async function loadListsFromGitHub() {
  const files = await ghListCSVs(); // [{name, download_url}, ...]
  const lists = {};
  PREFERRED_KIND.clear();

  for (const f of files) {
    const listName = f.name.replace(/\.csv$/i, "");
    const kind = looksSeries(listName) ? "series" : "movie";
    const raw = await fetchRaw(f.download_url);
    const rows = parse(raw, { columns: true, skip_empty_lines: true });

    const items = rows.map((r) => {
      const imdbId = String(r.Const || "").trim();
      if (isImdb(imdbId)) PREFERRED_KIND.set(imdbId, kind);
      return {
        id: imdbId || `local:${r.Title || "Untitled"}:${r.Year || ""}`,
        type: kind, // REAL type on item (so stream add-ons trigger)
        name: (r.Title || "Untitled").trim(),
        year: r.Year ? Number(r.Year) : undefined,
        releaseDate: r["Release Date"] || undefined,
      };
    });

    lists[listName] = { kind, items };
  }
  LISTS = lists;

  console.log(
    "Loaded lists:",
    Object.entries(LISTS)
      .map(([k, v]) => `${k} (${v.kind})`)
      .join(", ") || "(none)"
  );
}

// best-effort initial load (will show empty catalogs if it fails)
loadListsFromGitHub().catch((e) => console.warn("Initial GitHub load failed:", e.message));

// --------- Manifest & builder ----------
const catalogs = () =>
  Object.keys(LISTS).map((name) => ({
    type: "mylists",                         // custom section
    id: `list:${name}`,
    name: `🗂 My Lists • ${name}`,
    extraSupported: ["search", "skip", "limit", "sort"],
    extra: [
      { name: "search" },
      { name: "skip" },
      { name: "limit" },
      {
        name: "sort",
        options: [
          "date_asc",
          "date_desc",
          "rating_asc",
          "rating_desc",
          "runtime_asc",
          "runtime_desc",
          "name_asc",
          "name_desc",
        ],
      },
    ],
  }));

const manifest = {
  id: "org.my.csvlists",
  version: "5.0.1",
  name: "My Lists",
  description:
    "Your CSV lists under one section; opens real movie/series pages so streams load.",
  resources: ["catalog", "meta"],
  types: ["mylists", "movie", "series"],
  idPrefixes: ["tt"],
  catalogs: catalogs(),
};

const builder = new addonBuilder(manifest);

// enrich minimal meta for catalog cards (poster, rating/runtime for sort)
async function enrichForCard(prefKind, m) {
  const imdbId = isImdb(m.id) ? m.id : null;
  if (!imdbId) return m;
  const first = await fetchCinemeta(prefKind, imdbId);
  const cm = first || (await fetchCinemeta(prefKind === "movie" ? "series" : "movie", imdbId));
  return cm
    ? {
        ...m,
        poster: cm.poster || m.poster,
        background: cm.background || m.background,
        logo: cm.logo || m.logo,
        imdbRating: cm.imdbRating ?? m.imdbRating,
        runtime: cm.runtime ?? m.runtime,
        year: m.year ?? cm.year,
        description: m.description ?? cm.description,
      }
    : m;
}

builder.defineCatalogHandler(async ({ id, extra }) => {
  if (!id?.startsWith("list:")) return { metas: [] };
  const listName = id.slice(5);
  const list = LISTS[listName];
  if (!list) return { metas: [] };

  const pref = list.kind;
  const enrichedAll = await Promise.all((list.items || []).map((m) => enrichForCard(pref, m)));

  const q = (extra?.search || "").toLowerCase().trim();
  let metas = q
    ? enrichedAll.filter(
        (m) =>
          (m.name || "").toLowerCase().includes(q) ||
          (m.description || "").toLowerCase().includes(q)
      )
    : enrichedAll;

  const sort = (extra?.sort || "").toLowerCase();
  const dir = sort.endsWith("_asc") ? 1 : -1;
  const byDate = (a, b) =>
    ((new Date(a.releaseDate || `${a.year || 0}-01-01`)).getTime() -
      (new Date(b.releaseDate || `${b.year || 0}-01-01`)).getTime()) * dir;
  const byRating = (a, b) => ((a.imdbRating || 0) - (b.imdbRating || 0)) * dir;
  const byRuntime = (a, b) => ((a.runtime || 0) - (b.runtime || 0)) * dir;
  const byName = (a, b) => (a.name || "").localeCompare(b.name || "") * dir;

  if (sort.startsWith("date_")) metas = [...metas].sort(byDate);
  if (sort.startsWith("rating_")) metas = [...metas].sort(byRating);
  if (sort.startsWith("runtime_")) metas = [...metas].sort(byRuntime);
  if (sort.startsWith("name_")) metas = [...metas].sort(byName);

  const skip = Number(extra?.skip || 0);
  const limit = Math.min(Number(extra?.limit || 100), 200);
  metas = metas.slice(skip, skip + limit);

  return { metas };
});

builder.defineMetaHandler(async ({ id }) => {
  const imdbId = isImdb(id) ? id : null;
  if (!imdbId) return { meta: { id, type: "movie", name: "Unknown item" } };

  const pref = PREFERRED_KIND.get(imdbId) || "movie";
  let meta = await fetchCinemeta(pref, imdbId);
  let kind = pref;

  if (!meta) {
    const other = pref === "movie" ? "series" : "movie";
    meta = await fetchCinemeta(other, imdbId);
    if (meta) kind = other;
  }
  if (!meta) return { meta: { id, type: kind } };
  return { meta: { ...meta, id, type: kind } };
});

// --------- Express server: addon + admin UI ----------
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

function addonAllowed(req) {
  if (!SHARED_SECRET) return true;
  const url = new URL(req.originalUrl, `http://${req.headers.host}`);
  return url.searchParams.get("key") === SHARED_SECRET;
}
function adminAllowed(req) {
  const url = new URL(req.originalUrl, `http://${req.headers.host}`);
  return (url.searchParams.get("admin") || req.headers["x-admin-key"]) === ADMIN_PASSWORD;
}

// health
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ✅ Serve manifest ourselves to avoid SDK serialization issues
app.get("/manifest.json", (req, res) => {
  if (!addonAllowed(req)) return res.status(403).send("Forbidden");
  try {
    // update catalogs snapshot on every manifest hit (so new CSVs show up immediately)
    builder.manifest.catalogs = catalogs();
    res.json(builder.manifest);
  } catch (e) {
    console.error("Manifest error:", e);
    res.status(500).send("Manifest error");
  }
});

// admin page
app.get("/admin", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  let files = [];
  try {
    files = await ghListCSVs();
  } catch {}
  const list = files.map((f) => `<li>${f.name}</li>`).join("") || "<li>(none yet)</li>";

  // build a correct external URL whether RENDER_EXTERNAL_URL has protocol or not
  const external = process.env.RENDER_EXTERNAL_URL || "";
  const baseUrl = external
    ? (external.startsWith("http") ? external : `https://${external}`).replace(/\/$/, "")
    : "<your-app>.onrender.com";

  res.type("html").send(`<!doctype html>
<html>
<head>
<title>My Lists Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:760px}
h1{margin:0 0 16px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
label{display:block;margin:8px 0 4px}
input[type=text],input[type=password]{width:100%;padding:10px;border:1px solid #ccc;border-radius:8px}
button{padding:10px 16px;border:0;border-radius:8px;background:#6c5ce7;color:#fff;cursor:pointer}
ul{padding-left:18px}
small{color:#666}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}
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
      <p><small>If filename contains “series”, it will be treated as a Series list.</small></p>
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
    <h3>Manifest URL</h3>
    <p>Install in Stremio via:</p>
    <p class="code">${baseUrl}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}</p>
  </div>
</body>
</html>`);
});

// upload API -> commits CSV into GitHub repo under CSV_DIR; then reloads
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    if (!req.file) return res.status(400).send("Missing file");
    const nameInput = String(req.body.name || "").trim().replace(/[^A-Za-z0-9_\-]/g, "_");
    if (!nameInput) return res.status(400).send("Bad name");
    const filename = `${nameInput}.csv`;
    const base64 = Buffer.from(req.file.buffer).toString("base64");
    await ghPutCSV(filename, base64);
    await loadListsFromGitHub();
    // refresh catalogs snapshot so /manifest shows the new shelf immediately
    builder.manifest.catalogs = catalogs();
    res
      .status(200)
      .send(`Uploaded ${filename} and reloaded. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  } catch (e) {
    console.error("Upload error:", e);
    res.status(500).send(String(e));
  }
});

// manual reload endpoint
app.post("/api/reload", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    await loadListsFromGitHub();
    builder.manifest.catalogs = catalogs();
    res.status(200).send(`Reloaded. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// mount the SDK interface for /catalog and /meta (manifest is served above)
const addonInterface = builder.getInterface();
app.use((req, res, next) => {
  if (/\/(catalog|meta)/.test(req.url)) {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
  }
  return addonInterface(req, res);
});

// start
app.listen(PORT, HOST, () => {
  const base = `http://localhost:${PORT}`;
  console.log(`Admin: ${base}/admin${ADMIN_PASSWORD ? `?admin=${ADMIN_PASSWORD}` : ""}`);
  console.log(`Manifest: ${base}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
});
