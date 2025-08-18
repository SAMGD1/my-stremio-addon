// My Lists — single custom section; real meta types so streams load
// CSVs in ./data/*.csv with columns: Const (IMDb id), Title, Release Date, Year
// If a CSV filename contains "series" (case-insensitive), it’s treated as series; otherwise movie.

const { addonBuilder } = require("stremio-addon-sdk");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { parse } = require("csv-parse/sync");

// ---------- config ----------
const DATA_DIR = path.join(__dirname, "data");
const CINEMETA = "https://v3-cinemeta.strem.io";
const PORT = Number(process.env.PORT) || 7000;
const HOST = "0.0.0.0";
const SECRET = process.env.SHARED_SECRET || ""; // optional: protect your addon

// ---------- helpers ----------
const isImdb = v => /^tt\d+$/i.test(String(v || ""));
const looksSeries = name => /series/i.test(name || "");

// cache Cinemeta results
const metaCache = new Map();
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

// remember preferred kind per IMDb id (movie/series)
const PREFERRED_KIND = new Map();

// ---------- load CSVs ----------
function loadLists() {
  const lists = {}; // { listName: { kind: 'movie'|'series', items: [...] } }
  if (!fs.existsSync(DATA_DIR)) return lists;
  const files = fs.readdirSync(DATA_DIR).filter(f => f.toLowerCase().endsWith(".csv"));
  for (const file of files) {
    const rows = parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"), {
      columns: true, skip_empty_lines: true
    });
    const listName = path.parse(file).name;
    const kind = looksSeries(listName) ? "series" : "movie";

    const items = rows.map(r => {
      const imdbId = String(r.Const || "").trim();
      if (isImdb(imdbId)) PREFERRED_KIND.set(imdbId, kind);
      return {
        id: imdbId || `local:${r.Title || "Untitled"}:${r.Year || ""}`,
        type: kind, // REAL type on the item
        name: (r.Title || "Untitled").trim(),
        year: r.Year ? Number(r.Year) : undefined,
        releaseDate: r["Release Date"] || undefined
      };
    });

    lists[listName] = { kind, items };
  }
  return lists;
}
let LISTS = loadLists();

// ---------- manifest (ONE custom section) ----------
const catalogs = Object.keys(LISTS).map(name => ({
  type: "mylists",
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
        "date_asc","date_desc",
        "rating_asc","rating_desc",
        "runtime_asc","runtime_desc",
        "name_asc","name_desc"
      ]
    }
  ]
}));

const manifest = {
  id: "org.my.csvlists",
  version: "4.0.0",
  name: "My Lists",
  description: "Your CSV lists in one section; opens real movie/series pages so streams load.",
  resources: ["catalog", "meta"],            // NOTE: no 'stream'
  types: ["mylists", "movie", "series"],     // advertise real types
  idPrefixes: ["tt"],
  catalogs
};

const { addonBuilder: _ignore } = require("stremio-addon-sdk");
const builder = new addonBuilder(manifest);

// enrich cards for posters/rating/runtime so sorts work nicely
async function enrichForCard(preferredKind, m) {
  const imdbId = isImdb(m.id) ? m.id : null;
  if (!imdbId) return m;
  const first = await fetchCinemeta(preferredKind, imdbId);
  const cm = first || await fetchCinemeta(preferredKind === "movie" ? "series" : "movie", imdbId);
  return cm ? {
    ...m,
    poster: cm.poster || m.poster,
    background: cm.background || m.background,
    logo: cm.logo || m.logo,
    imdbRating: cm.imdbRating ?? m.imdbRating,
    runtime: cm.runtime ?? m.runtime,
    year: m.year ?? cm.year,
    description: m.description ?? cm.description
  } : m;
}

// catalog handler
builder.defineCatalogHandler(async ({ id, extra }) => {
  if (!id?.startsWith("list:")) return { metas: [] };
  const listName = id.slice(5);
  const list = LISTS[listName];
  if (!list) return { metas: [] };

  const preferredKind = list.kind;
  const enrichedAll = await Promise.all(list.items.map(m => enrichForCard(preferredKind, m)));

  // search
  const q = (extra?.search || "").toLowerCase().trim();
  let metas = q
    ? enrichedAll.filter(m =>
        (m.name || "").toLowerCase().includes(q) ||
        (m.description || "").toLowerCase().includes(q)
      )
    : enrichedAll;

  // sort
  const sort = (extra?.sort || "").toLowerCase();
  const dir = sort.endsWith("_asc") ? 1 : -1;
  const byDate    = (a,b) => ((new Date(a.releaseDate || `${a.year || 0}-01-01`)).getTime() - (new Date(b.releaseDate || `${b.year || 0}-01-01`)).getTime()) * dir;
  const byRating  = (a,b) => ((a.imdbRating || 0) - (b.imdbRating || 0)) * dir;
  const byRuntime = (a,b) => ((a.runtime || 0) - (b.runtime || 0)) * dir;
  const byName    = (a,b) => (a.name || "").localeCompare(b.name || "") * dir;

  if (sort.startsWith("date_"))    metas = [...metas].sort(byDate);
  if (sort.startsWith("rating_"))  metas = [...metas].sort(byRating);
  if (sort.startsWith("runtime_")) metas = [...metas].sort(byRuntime);
  if (sort.startsWith("name_"))    metas = [...metas].sort(byName);

  // page
  const skip = Number(extra?.skip || 0);
  const limit = Math.min(Number(extra?.limit || 100), 200);
  metas = metas.slice(skip, skip + limit);

  return { metas };
});

// meta handler -> ALWAYS return real type so streams load
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

// ---------- server with optional secret ----------
const addonInterface = builder.getInterface();

function allowed(req) {
  if (!SECRET) return true;
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    return url.searchParams.get("key") === SECRET;
  } catch { return false; }
}

http.createServer((req, res) => {
  if (!allowed(req)) { res.writeHead(403); res.end("Forbidden"); return; }
  // small health check
  if (req.url.startsWith("/health")) { res.writeHead(200); res.end("ok"); return; }
  addonInterface(req, res);
}).listen(PORT, HOST, () => {
  const shownHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`My Lists running at http://${shownHost}:${PORT}/manifest.json${SECRET ? `?key=${SECRET}` : ""}`);
  console.log("Shelves:", Object.entries(LISTS).map(([k,v]) => `${k} (${v.kind})`).join(", ") || "(none)");
});

// watch CSVs locally (useful when running locally)
if (fs.existsSync(DATA_DIR)) {
  fs.watch(DATA_DIR, { persistent: false }, () => {
    LISTS = loadLists();
    console.log("CSV reloaded");
  });
}
