// My Lists add-on with Admin UI (GitHub-backed storage)
// One "My Lists" section. Items open as real movie/series pages so other
// stream add-ons load. CSVs live in your GitHub repo and can be uploaded
// from /admin (which commits and hot-reloads).

const express = require("express");
const multer = require("multer");
const { parse } = require("csv-parse/sync");

// ---- env ----
const PORT = Number(process.env.PORT) || 7000;
const HOST = "0.0.0.0";

// Secrets
const SHARED_SECRET   = process.env.SHARED_SECRET || "";                 // optional
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD || "Stremio_172";     // <-- default per your note

// GitHub repo that stores CSVs
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN  || "";
const GITHUB_OWNER    = process.env.GITHUB_OWNER  || "";
const GITHUB_REPO     = process.env.GITHUB_REPO   || "";
const GITHUB_BRANCH   = process.env.GITHUB_BRANCH || "main";
const CSV_DIR         = process.env.CSV_DIR       || "data";

// sanity hints
if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.warn("WARNING: Set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO in Render → Environment.");
}
if (!ADMIN_PASSWORD) {
  console.warn("WARNING: ADMIN_PASSWORD missing; /admin will be unusable.");
}

// ---- helpers ----
const CINEMETA = "https://v3-cinemeta.strem.io";
const looksSeries = (name) => /series/i.test(name || "");
const isImdb = (v) => /^tt\d+$/i.test(String(v || ""));

// in-memory stores
let LISTS = {};                   // { listName: { kind: 'movie'|'series', items: [...] } }
const PREFERRED_KIND = new Map(); // imdbId -> 'movie'|'series'
const metaCache = new Map();      // `${kind}:${id}` -> meta

// tiny fetch
async function fetchRaw(url) {
  const r = await fetch(url, { headers: { Accept: "text/plain" } });
  if (!r.ok) throw new Error(`raw fetch failed ${r.status}`);
  return r.text();
}

// ---- GitHub Content API ----
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
    return (Array.isArray(data) ? data : []).filter(
      (f) => f.type === "file" && /\.csv$/i.test(f.name)
    );
  } catch (e) {
    if (String(e.message).includes("404")) return [];
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
  const sha = await ghGetFileSha(rel);
  const body = {
    message: `Upload ${filename}`,
    content: base64Content,
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  return ghRequest("PUT", `/contents/${encodeURIComponent(rel)}`, body);
}

// ---- Cinemeta ----
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

// ---- Load CSVs into LISTS ----
async function loadListsFromGitHub() {
  const files = await ghListCSVs();
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
        type: kind,
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

// initial best-effort load
loadListsFromGitHub().catch((e) => console.warn("Initial load failed:", e.message));

// ---- Stremio manifest, computed on demand (so we never mutate a builder) ----
const baseManifest = {
  id: "org.my.csvlists",
  version: "5.0.0",
  name: "My Lists",
  description:
    "Your CSV lists under one section; opens real movie/series pages so streams load.",
  resources: ["catalog", "meta"],
  types: ["my lists", "movie", "series"],
  idPrefixes: ["tt"],
};

function catalogs() {
  return Object.keys(LISTS).map((name) => ({
    type: "My lists",
    id: `list:${name}`,
    name: `🗂 ${name}`,
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
}

// ---- Express app (serves both Stremio routes + Admin) ----
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// CORS for Stremio
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

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

// ---- STREMIO: MANIFEST ----
app.get("/manifest.json", (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    const manifest = { ...baseManifest, catalogs: catalogs() };
    res.json(manifest);
  } catch (e) {
    console.error("Manifest error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// helper: parse Stremio /catalog extra
function parseExtra(extraStr, queryObj) {
  const params = new URLSearchParams(extraStr || "");
  const fromPath = Object.fromEntries(params.entries());
  return { ...fromPath, ...(queryObj || {}) };
}

// ---- STREMIO: CATALOG ----
app.get("/catalog/:type/:id/:extra?.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");

    const { id } = req.params;
    if (!id?.startsWith("list:")) return res.json({ metas: [] });

    const listName = id.slice(5);
    const list = LISTS[listName];
    if (!list) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);

    // Enrich minimal card info (poster/rating/runtime) via Cinemeta
    async function enrichForCard(prefKind, m) {
      const imdbId = isImdb(m.id) ? m.id : null;
      if (!imdbId) return m;
      const first = await fetchCinemeta(prefKind, imdbId);
      const cm =
        first || (await fetchCinemeta(prefKind === "movie" ? "series" : "movie", imdbId));
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

    const pref = list.kind;
    const enrichedAll = await Promise.all((list.items || []).map((m) => enrichForCard(pref, m)));

    // search
    const q = String(extra.search || "").toLowerCase().trim();
    let metas = q
      ? enrichedAll.filter(
          (m) =>
            (m.name || "").toLowerCase().includes(q) ||
            (m.description || "").toLowerCase().includes(q)
        )
      : enrichedAll;

    // sort
    const sort = String(extra.sort || "").toLowerCase();
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

    const skip = Number(extra.skip || 0);
    const limit = Math.min(Number(extra.limit || 100), 200);
    metas = metas.slice(skip, skip + limit);

    res.json({ metas });
  } catch (e) {
    console.error("Catalog error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ---- STREMIO: META ----
app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    const imdbId = req.params.id;
    if (!isImdb(imdbId))
      return res.json({ meta: { id: imdbId, type: "movie", name: "Unknown item" } });

    const pref = PREFERRED_KIND.get(imdbId) || "movie";
    let meta = await fetchCinemeta(pref, imdbId);
    let kind = pref;

    if (!meta) {
      const other = pref === "movie" ? "series" : "movie";
      meta = await fetchCinemeta(other, imdbId);
      if (meta) kind = other;
    }
    if (!meta) return res.json({ meta: { id: imdbId, type: kind } });
    res.json({ meta: { ...meta, id: imdbId, type: kind } });
  } catch (e) {
    console.error("Meta error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ---- ADMIN UI ----
function absoluteBase(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

app.get("/admin", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  let files = [];
  try {
    files = await ghListCSVs();
  } catch (_) {}
  const list = files.map((f) => `<li>${f.name}</li>`).join("") || "<li>(none yet)</li>";
  const manifestUrl = `${absoluteBase(req)}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;
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
    const nameInput = String(req.body.name || "").trim().replace(/[^A-Za-z0-9_\-]/g, "_");
    if (!nameInput) return res.status(400).send("Bad name");
    const filename = `${nameInput}.csv`;
    const base64 = Buffer.from(req.file.buffer).toString("base64");
    await ghPutCSV(filename, base64);
    await loadListsFromGitHub();
    res
      .status(200)
      .send(
        `Uploaded ${filename} and reloaded. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`
      );
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

app.post("/api/reload", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    await loadListsFromGitHub();
    res
      .status(200)
      .send(`Reloaded. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

// ---- start ----
app.listen(PORT, HOST, () => {
  console.log(`Admin: http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
  console.log(
    `Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`
  );
});
