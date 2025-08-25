/*  My Lists – IMDb → Stremio catalogs (robust)
 *  v10.0
 *  - Discovers all public lists from IMDB_USER_URL (stable ls######## IDs)
 *  - Paginates every list; de-dupes; optional episode→series upgrade
 *  - Metadata: Cinemeta → OMDb (optional) → TMDb (optional) → IMDb JSON-LD/OG
 *  - Admin UI: enable/disable lists, order, per-list default sort, default list,
 *              option to upgrade episodes to series; Save without reinstall
 *  - Snapshot + prefs optional persistence in GitHub repo
 *  - Manifest version auto-bumps on list/prefs changes
 */

const express = require("express");

// ----------------- ENV -----------------
const PORT  = Number(process.env.PORT || 7000);
const HOST  = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

// Optional external metadata accelerators
const OMDB_API_KEY = process.env.OMDB_API_KEY || "";     // https://www.omdbapi.com/apikey.aspx
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";     // https://www.themoviedb.org/settings/api

// Optional GitHub persistence (snapshot + prefs)
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN    || "";
const GITHUB_OWNER    = process.env.GITHUB_OWNER    || "";
const GITHUB_REPO     = process.env.GITHUB_REPO     || "";
const GITHUB_BRANCH   = process.env.GITHUB_BRANCH   || "main";
const SNAPSHOT_DIR    = process.env.CSV_DIR         || "data";           // keep your old var name
const SNAPSHOT_FILE   = `${SNAPSHOT_DIR}/snapshot.json`;

const GH_ENABLED = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);

// ----------------- CONSTANTS -----------------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/10.0";
const CINEMETA = "https://v3-cinemeta.strem.io";

// ----------------- STATE -----------------
// LISTS keyed by stable IMDb list id "ls##########"
//
// LISTS = {
//   ls4107...: { id, name, url, ids: [ 'tt...' ] }
// }
let LISTS = Object.create(null);

// PREFS (user customizations)
let PREFS = {
  enabled: [],           // array of ls ids allowed; [] => all
  order: [],             // array for catalog order (ls ids)
  defaultList: "",       // ls id to open first in Stremio
  perListSort: {},       // { lsid: "date_desc" | "name_asc" | ... }
  upgradeEpisodes: true  // if true, episode tt → parent series tt
};

// Caches
const BEST   = new Map(); // Map<tt, { kind:'movie'|'series'|null, meta:object|null }>
const FALLBK = new Map(); // Map<tt, { name?:string, poster?:string, year?:number, releaseDate?:string, type?:'movie'|'series' }>
const CARD   = new Map(); // Map<tt, card>
const EP2SER = new Map(); // Map<episode_tt, parent_series_tt>

// status
let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;

// manifest rev; bump on list/prefs change
let MANIFEST_REV = 1;
let LAST_MANIFEST_KEY = "";

// ----------------- UTILS -----------------
function isImdb(v) { return /^tt\d{7,}$/i.test(String(v || "")); }
function isListId(v){ return /^ls\d{6,}$/i.test(String(v || "")); }
function nowIso(){ return new Date().toISOString(); }
function minToMs(m){ return m * 60 * 1000; }

async function fetchText(url, accept) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": accept || "text/html,*/*" }});
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" }});
  if (!r.ok) return null;
  return r.json().catch(() => null);
}
function withParam(url, key, val) { const u = new URL(url); u.searchParams.set(key, val); return u.toString(); }

// ----------------- GITHUB PERSISTENCE -----------------
async function gh(method, path, bodyObj) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": UA
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`GitHub ${method} ${path} -> ${r.status}: ${t}`);
  }
  return r.json();
}
async function ghGetSha(path) {
  try {
    const data = await gh("GET", `/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    return data && data.sha || null;
  } catch { return null; }
}
async function ghWriteSnapshot(obj) {
  if (!GH_ENABLED) return;
  const content = Buffer.from(JSON.stringify(obj, null, 2)).toString("base64");
  const sha = await ghGetSha(SNAPSHOT_FILE);
  const body = { message: "Update snapshot.json", content, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  await gh("PUT", `/contents/${encodeURIComponent(SNAPSHOT_FILE)}`, body);
}
async function ghReadSnapshot() {
  if (!GH_ENABLED) return null;
  try {
    const data = await gh("GET", `/contents/${encodeURIComponent(SNAPSHOT_FILE)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
    const buf = Buffer.from(data.content, "base64").toString("utf8");
    return JSON.parse(buf);
  } catch { return null; }
}

// ----------------- IMDb DISCOVERY -----------------
async function discoverListsFromUser(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(withParam(userListsUrl, "_", Date.now()), "text/html");
  // Find every /list/ls##########/ link, dedupe by id
  const re = /href="\/list\/(ls\d{6,})\/"/gi;
  const ids = new Set();
  const arr = [];
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (!ids.has(id)) { ids.add(id); arr.push({ id, url: `https://www.imdb.com/list/${id}/` }); }
  }
  // Resolve names by opening each list header (fast, small)
  await Promise.all(arr.map(async L => {
    try { L.name = await fetchListName(L.url); } catch { L.name = L.id; }
  }));
  return arr;
}

async function fetchListName(listUrl) {
  const html = await fetchText(withParam(listUrl, "_", Date.now()), "text/html");
  // Try multiple patterns
  const tries = [
    /<h1[^>]+data-testid="list-header-title"[^>]*>(.*?)<\/h1>/i,
    /<h1[^>]*class="[^"]*header[^"]*"[^>]*>(.*?)<\/h1>/i,
    /<title>(.*?)<\/title>/i
  ];
  for (const rx of tries) {
    const m = html.match(rx);
    if (m) {
      const name = m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (name) return name;
    }
  }
  return listUrl;
}

// Parse ids from a single list page
function parseTconsts(html) {
  const seen = new Set();
  const out = [];
  let m;
  // prefer data-tconst
  const re1 = /data-tconst="(tt\d{7,})"/gi;
  while ((m = re1.exec(html))) {
    const tt = m[1];
    if (!seen.has(tt)) { seen.add(tt); out.push(tt); }
  }
  // fall back to /title/tt#######
  const re2 = /\/title\/(tt\d{7,})\//gi;
  while ((m = re2.exec(html))) {
    const tt = m[1];
    if (!seen.has(tt)) { seen.add(tt); out.push(tt); }
  }
  return out;
}

// next page link
function findNextPage(html) {
  let m = html.match(/<a[^>]+rel="next"[^>]+href="([^"]+)"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*lister-page-next[^"]*"/i);
  if (!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*data-testid="pagination-next-page-button"[^>]*>/i);
  if (!m) return null;
  try { return new URL(m[1], "https://www.imdb.com").toString(); }
  catch { return null; }
}

async function fetchListItemsAllPages(listUrl, maxPages = 60) {
  const modes = ["detail", "grid", "compact"];
  const seen = new Set();
  const ids  = [];
  for (const mode of modes) {
    let pageUrl = withParam(listUrl, "mode", mode);
    let pages = 0;
    while (pageUrl && pages < maxPages) {
      let html;
      try { html = await fetchText(withParam(pageUrl, "_", Date.now()), "text/html"); }
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
    }
    if (ids.length) break; // one successful mode is enough
  }
  return ids;
}

// ----------------- METADATA HELPERS -----------------
async function fetchCinemeta(kind, imdbId) {
  try {
    const j = await fetchJson(`${CINEMETA}/meta/${kind}/${imdbId}.json`);
    return j && j.meta ? j.meta : null;
  } catch { return null; }
}

async function imdbTitleJsonLd(imdbId) {
  try {
    const html = await fetchText(`https://www.imdb.com/title/${imdbId}/`, "text/html");
    // JSON-LD
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (m) {
      try { return JSON.parse(m[1]); } catch { /* ignore */ }
    }
    // OG fallback
    const t = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    const p = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    return { name: t ? t[1] : undefined, image: p ? p[1] : undefined };
  } catch { return null; }
}

async function omdbById(imdbId) {
  if (!OMDB_API_KEY) return null;
  const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(OMDB_API_KEY)}&i=${encodeURIComponent(imdbId)}`;
  return fetchJson(url);
}

async function tmdbFindByImdb(imdbId) {
  if (!TMDB_API_KEY) return null;
  const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id`;
  return fetchJson(url);
}

// If this tt is an EPISODE, try to map it to its parent series tt
async function resolveEpisodeToSeries(imdbId) {
  if (EP2SER.has(imdbId)) return EP2SER.get(imdbId);
  const ld = await imdbTitleJsonLd(imdbId);
  let seriesId = null;
  try {
    // JSON-LD shapes vary; look for partOfSeries or a @graph entry
    const node = Array.isArray(ld && ld["@graph"]) ? ld["@graph"].find(x => x["@type"] === "TVEpisode") : ld;
    const part = node && (node.partOfSeries || node.partOfTVSeries || node.partOfSeason && node.partOfSeason.partOfSeries);
    if (part) {
      const url = typeof part === "string" ? part : (part.url || part.sameAs || part["@id"]);
      if (url) {
        const m = String(url).match(/tt\d{7,}/i);
        if (m) seriesId = m[0];
      }
    }
  } catch { /* ignore */ }
  if (seriesId) EP2SER.set(imdbId, seriesId);
  return seriesId;
}

async function getBestMeta(imdbId) {
  if (BEST.has(imdbId)) return BEST.get(imdbId);

  // 1) Cinemeta movie→series
  let meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind: "movie", meta }; BEST.set(imdbId, rec); return rec; }
  meta = await fetchCinemeta("series", imdbId);
  if (meta) { const rec = { kind: "series", meta }; BEST.set(imdbId, rec); return rec; }

  // 2) OMDb (fast, by imdb id)
  const om = await omdbById(imdbId).catch(()=>null);
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
        released: om.Released && om.Released !== "N/A" ? om.Released : undefined,
      }
    };
    BEST.set(imdbId, rec);
    return rec;
  }

  // 3) TMDb (find by imdb_id)
  const t = await tmdbFindByImdb(imdbId).catch(()=>null);
  if (t && (t.movie_results?.length || t.tv_results?.length)) {
    const tv = t.tv_results?.[0];
    const mv = t.movie_results?.[0];
    const sel = tv || mv;
    const kind = tv ? "series" : "movie";
    const poster = sel.poster_path ? `https://image.tmdb.org/t/p/w500${sel.poster_path}` : undefined;
    const year = sel.release_date ? Number(sel.release_date.slice(0,4)) :
                 sel.first_air_date ? Number(sel.first_air_date.slice(0,4)) : undefined;
    const released = sel.release_date || sel.first_air_date;
    const rec = {
      kind,
      meta: {
        name: sel.name || sel.title,
        poster,
        year,
        released,
        description: sel.overview || undefined,
        imdbRating: undefined
      }
    };
    BEST.set(imdbId, rec);
    return rec;
  }

  // 4) IMDb JSON-LD / OG (last resort)
  const ld = await imdbTitleJsonLd(imdbId);
  let name, poster, released, year, type;
  try {
    const node = Array.isArray(ld && ld["@graph"]) ? ld["@graph"].find(x => x["@id"]?.includes(`/title/${imdbId}`)) || ld["@graph"][0] : ld;
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

function toTimestamp(dateStr, year) {
  if (dateStr) { const n = Date.parse(dateStr); if (!Number.isNaN(n)) return n; }
  if (year)    { const n = Date.parse(`${year}-01-01`); if (!Number.isNaN(n)) return n; }
  return null;
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

// stable manifest key (enabled+order+names)
function manifestKey() {
  const enabled = (PREFS.enabled && PREFS.enabled.length) ? PREFS.enabled : Object.keys(LISTS);
  const names = enabled.map(id => LISTS[id]?.name || id).sort().join("|");
  return `${enabled.join(",")}#${PREFS.order.join(",")}#${PREFS.defaultList}#${names}`;
}

// ----------------- SYNC -----------------
async function fullSync({ rediscover = true } = {}) {
  if (syncInProgress) return;
  syncInProgress = true;
  try {
    // discover lists
    let discovered = [];
    if (IMDB_USER_URL && rediscover) {
      try { discovered = await discoverListsFromUser(IMDB_USER_URL); }
      catch(e){ console.warn("IMDb discovery failed:", e.message); }
    }
    // if we already have lists, keep known names; merge discovered
    const next = Object.create(null);
    const toFetch = [];

    const knownIds = new Set(Object.keys(LISTS));
    for (const D of discovered) {
      next[D.id] = { id: D.id, name: D.name || D.id, url: D.url, ids: [] };
      toFetch.push(D.id);
      knownIds.delete(D.id);
    }
    // keep any lists from previous snapshot that were not rediscovered this time (IMDb hiccup)
    for (const leftover of knownIds) {
      next[leftover] = LISTS[leftover];
      if (next[leftover] && (!next[leftover].ids || !next[leftover].ids.length)) toFetch.push(leftover);
    }

    // fetch items per list
    const unique = new Set();
    for (const id of Object.keys(next)) {
      const url = next[id].url || `https://www.imdb.com/list/${id}/`;
      let ids = [];
      try { ids = await fetchListItemsAllPages(url); } catch {}
      next[id].ids = ids;
      for (const tt of ids) unique.add(tt);
    }

    // normalize episodes → parent series if enabled
    let idsToPreload = Array.from(unique);
    if (PREFS.upgradeEpisodes) {
      const upgraded = new Set();
      for (const tt of idsToPreload) {
        const rec = await getBestMeta(tt);
        // if Cinemeta/OMDb/TMDb said it's a movie but the LD says TVEpisode, try mapping
        let isMaybeEpisode = false;
        const fb = FALLBK.get(tt);
        if (fb && fb.type === "episode") isMaybeEpisode = true;
        if (isMaybeEpisode) {
          const ser = await resolveEpisodeToSeries(tt);
          if (ser && isImdb(ser)) upgraded.add(ser);
          else upgraded.add(tt);
        } else {
          upgraded.add(tt);
        }
      }
      idsToPreload = Array.from(upgraded);
      // also remap each LIST ids
      for (const id of Object.keys(next)) {
        const remapped = [];
        const seen = new Set();
        for (const tt of next[id].ids) {
          let final = tt;
          if (PREFS.upgradeEpisodes) {
            const fb = FALLBK.get(tt);
            if (fb && fb.type === "episode") {
              const ser = await resolveEpisodeToSeries(tt);
              if (ser) final = ser;
            }
          }
          if (!seen.has(final)) { seen.add(final); remapped.push(final); }
        }
        next[id].ids = remapped;
      }
    }

    // preload meta + build cards
    for (const tt of idsToPreload) { await getBestMeta(tt); }
    CARD.clear();
    for (const tt of idsToPreload) { CARD.set(tt, buildCard(tt)); }

    LISTS = next;
    LAST_SYNC_AT = Date.now();

    // bump manifest rev if catalogs set changed (or prefs changed later on save)
    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) {
      LAST_MANIFEST_KEY = key;
      MANIFEST_REV++;
      console.log("[SYNC] catalogs changed → manifest rev", MANIFEST_REV);
    }

    console.log(`[SYNC] ok – ${idsToPreload.length} ids across ${Object.keys(LISTS).length} lists in 0 min`);
    // persist snapshot + prefs
    if (GH_ENABLED) {
      try {
        await ghWriteSnapshot({
          lastSyncAt: LAST_SYNC_AT,
          manifestRev: MANIFEST_REV,
          lists: LISTS,
          prefs: PREFS,
          fallback: Object.fromEntries(FALLBK),
          cards: Object.fromEntries(CARD),
          ep2ser: Object.fromEntries(EP2SER)
        });
      } catch (e) { console.warn("[SYNC] snapshot save failed:", e.message); }
    }

  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    syncInProgress = false;
  }
}

function scheduleNextSync(reset) {
  if (syncTimer) clearTimeout(syncTimer);
  if (IMDB_SYNC_MINUTES <= 0) return;
  const delay = minToMs(IMDB_SYNC_MINUTES);
  syncTimer = setTimeout(async () => {
    await fullSync({ rediscover: true });
    scheduleNextSync(true);
  }, reset ? delay : delay);
}

async function bootFromSnapshot() {
  if (!GH_ENABLED) return false;
  const snap = await ghReadSnapshot();
  if (!snap) return false;
  try {
    LISTS = snap.lists || LISTS;
    PREFS = { ...PREFS, ...(snap.prefs || {}) };
    // soft-restore caches
    FALLBK.clear(); if (snap.fallback) for (const [k,v] of Object.entries(snap.fallback)) FALLBK.set(k, v);
    CARD.clear();   if (snap.cards)    for (const [k,v] of Object.entries(snap.cards))    CARD.set(k, v);
    EP2SER.clear(); if (snap.ep2ser)   for (const [k,v] of Object.entries(snap.ep2ser))   EP2SER.set(k, v);
    MANIFEST_REV = snap.manifestRev || MANIFEST_REV;
    LAST_SYNC_AT = snap.lastSyncAt || 0;
    LAST_MANIFEST_KEY = manifestKey();
    console.log("[BOOT] snapshot loaded from GitHub");
    return true;
  } catch(e) {
    console.warn("[BOOT] invalid snapshot:", e.message);
    return false;
  }
}

// ----------------- SERVER -----------------
const app = express();
app.use((_, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });
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

app.get("/health", (_, res) => res.status(200).send("ok"));

// ------- Manifest -------
const baseManifest = {
  id: "org.mylists.snapshot",
  version: "10.0.0",
  name: "My Lists",
  description: "Your IMDb lists as instant catalogs (cached).",
  resources: ["catalog", "meta"],
  types: ["my lists", "movie", "series"],
  idPrefixes: ["tt"]
};

function effectiveEnabledListIds() {
  const discovered = Object.keys(LISTS);
  if (!PREFS.enabled || !PREFS.enabled.length) return discovered;
  // keep only enabled that exist
  const set = new Set(discovered);
  return PREFS.enabled.filter(id => set.has(id));
}

function catalogs() {
  const enabled = effectiveEnabledListIds();
  // order by prefs.order; then by name
  const ordering = new Map(enabled.map((id, i) => [id, i + 1000]));
  (PREFS.order || []).forEach((id, idx) => { if (ordering.has(id)) ordering.set(id, idx); });
  const sorted = enabled.slice().sort((a,b) => {
    const ia = ordering.get(a) ?? 9999, ib = ordering.get(b) ?? 9999;
    if (ia !== ib) return ia - ib;
    const na = LISTS[a]?.name || a, nb = LISTS[b]?.name || b;
    return na.localeCompare(nb);
  });

  return sorted.map((lsid) => ({
    type: "My lists",
    id: `list:${lsid}`,                             // stable catalog id
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
    res.setHeader("Cache-Control", "no-store");
    const version = baseManifest.version + "." + MANIFEST_REV;
    const cats = catalogs();
    res.json({ ...baseManifest, version, catalogs: cats });
  } catch (e) {
    console.error("Manifest error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ------- Helpers -------
function parseExtra(extraStr, queryObj) {
  const params = new URLSearchParams(extraStr || "");
  const fromPath = Object.fromEntries(params.entries());
  return { ...fromPath, ...(queryObj || {}) };
}

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
    .map((m, i) => ({ m, i }))
    .sort((A, B) => {
      const a = A.m, b = B.m;
      let c = 0;
      if (field === "date") c = cmpNullBottom(toTimestamp(a.releaseDate, a.year), toTimestamp(b.releaseDate, b.year));
      else if (field === "rating") c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
      else if (field === "runtime") c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
      else c = (a.name || "").localeCompare(b.name || "");
      if (c === 0) { // stable
        c = (a.name || "").localeCompare(b.name || "");
        if (c === 0) c = (a.id || "").localeCompare(b.id || "");
        if (c === 0) c = A.i - B.i;
      }
      return c * dir;
    })
    .map(x => x.m);
}

// ------- Catalog -------
app.get("/catalog/:type/:id/:extra?.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    res.setHeader("Cache-Control", "no-store");

    const { id } = req.params;               // id like "list:ls4107..."
    if (!id || !id.startsWith("list:")) return res.json({ metas: [] });

    const lsid = id.slice(5);
    const list = LISTS[lsid];
    if (!list) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q     = String(extra.search || "").toLowerCase().trim();
    const sort  = (extra.sort || PREFS.perListSort?.[lsid] || "name_asc").toLowerCase();
    const skip  = Math.max(0, Number(extra.skip || 0));
    const limit = Math.min(Number(extra.limit || 100), 200);

    let metas = (list.ids || []).map(tt => CARD.get(tt) || buildCard(tt));

    if (q) {
      metas = metas.filter(m =>
        (m.name || "").toLowerCase().includes(q) ||
        (m.id || "").toLowerCase().includes(q) ||
        (m.description || "").toLowerCase().includes(q)
      );
    }

    metas = sortMetas(metas, sort);
    const page = metas.slice(skip, skip + limit);
    res.json({ metas: page });
  } catch (e) {
    console.error("Catalog error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ------- Meta -------
app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    res.setHeader("Cache-Control", "no-store");
    const imdbId = req.params.id;
    if (!isImdb(imdbId))
      return res.json({ meta: { id: imdbId, type: "movie", name: "Unknown item" } });

    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);

    if (!rec || !rec.meta) {
      const fb = FALLBK.get(imdbId) || {};
      return res.json({ meta: { id: imdbId, type: rec?.kind || fb.type || "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
    }
    return res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
  } catch (e) {
    console.error("Meta error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ------- Admin UI -------
app.get("/admin", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  const base = absoluteBase(req);
  const manifestUrl = `${base}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`;

  // Rediscover lists to show "Discovered at ..." (does not mutate cache here)
  let discovered = [];
  try { if (IMDB_USER_URL) discovered = await discoverListsFromUser(IMDB_USER_URL); } catch {}

  const rows = Object.keys(LISTS).map(id => {
    const L = LISTS[id];
    const count = (L.ids || []).length;
    return `<li data-id="${id}"><b>${L.name || id}</b> <small>(${count} items)</small><br/><small>${L.url}</small></li>`;
  }).join("") || "<li>(none)</li>";

  const disc = discovered.map(d => `<li><b>${d.name || d.id}</b><br/><small>${d.url}</small></li>`).join("") || "<li>(none found or IMDb unreachable)</li>";

  res.type("html").send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Admin</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:900px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
button{padding:10px 16px;border:0;border-radius:8px;background:#6c5ce7;color:#fff;cursor:pointer}
.btn2{background:#2d6cdf}
small{color:#666}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}
input[type="checkbox"]{transform:scale(1.2);margin-right:8px}
table{width:100%;border-collapse:collapse}
th,td{padding:8px;border-bottom:1px solid #eee;text-align:left}
select, input[type="text"], input[type="number"]{padding:6px 8px;border:1px solid #ddd;border-radius:6px}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.badge{display:inline-block;background:#eee;border-radius:999px;padding:2px 8px;font-size:12px;margin-left:6px}
</style>
</head>
<body>
<h1>My Lists – Admin</h1>

<div class="card">
  <h3>Current Snapshot</h3>
  <ul>${rows}</ul>
  <p><small>Last sync: ${LAST_SYNC_AT ? new Date(LAST_SYNC_AT).toLocaleString() + " (" + Math.round((Date.now()-LAST_SYNC_AT)/60000) + " min ago)" : "never"}</small></p>
  <div class="row">
    <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}">
      <button class="btn2">Sync IMDb Lists Now</button>
    </form>
    <span class="badge">Auto-sync every ${IMDB_SYNC_MINUTES} min${IMDB_SYNC_MINUTES ? "" : " (disabled)"}</span>
  </div>
</div>

<div class="card">
  <h3>Customize (enable/disable, order, defaults)</h3>
  <div id="prefs"></div>
  <div class="row" style="margin-top:10px">
    <button id="saveBtn">Save</button>
  </div>
  <p id="saveMsg" style="color:#2d6cdf"></p>
</div>

<div class="card">
  <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
  <ul>${disc}</ul>
</div>

<div class="card">
  <h3>Manifest URL</h3>
  <p class="code">${manifestUrl}</p>
  <p><small>After saving, Stremio will auto-refresh when the manifest version bumps.</small></p>
</div>

<script>
async function getPrefs(){ const r = await fetch('/api/prefs?admin=${ADMIN_PASSWORD}'); return r.json(); }
async function getLists(){ const r = await fetch('/api/lists?admin=${ADMIN_PASSWORD}'); return r.json(); }

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

async function render() {
  const prefs = await getPrefs();
  const lists = await getLists();

  const container = document.getElementById('prefs'); container.innerHTML = "";

  const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));
  const order = prefs.order && prefs.order.length ? prefs.order.slice() : Object.keys(lists);

  // table
  const table = el('table');
  const thead = el('thead', {}, [el('tr',{},[
    el('th',{text:'Enabled'}), el('th',{text:'List (lsid)'}), el('th',{text:'Items'}),
    el('th',{text:'Order'}), el('th',{text:'Default sort'})
  ])]);
  table.appendChild(thead);
  const tbody = el('tbody');

  function makeRow(lsid, idx) {
    const L = lists[lsid];
    const tr = el('tr');
    const cb = el('input', {type:'checkbox'}); cb.checked = enabledSet.has(lsid);
    cb.addEventListener('change', ()=>{ if (cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); });

    const nameCell = el('td',{});
    nameCell.appendChild(el('div',{text:(L.name||lsid)}));
    nameCell.appendChild(el('small',{text:lsid}));

    const count = el('td',{text:String((L.ids||[]).length)});

    const orderCell = el('td');
    const up   = el('button',{text:'↑'}); up.style.marginRight='6px';
    const down = el('button',{text:'↓'});
    up.addEventListener('click', ()=>{
      const i = order.indexOf(lsid); if (i>0){ const tmp = order[i-1]; order[i-1]=order[i]; order[i]=tmp; render(); }
    });
    down.addEventListener('click', ()=>{
      const i = order.indexOf(lsid); if (i>=0 && i<order.length-1){ const tmp = order[i+1]; order[i+1]=order[i]; order[i]=tmp; render(); }
    });
    orderCell.appendChild(up); orderCell.appendChild(down);

    const sortSel = el('select');
    const opts = ["date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"];
    const def = (prefs.perListSort && prefs.perListSort[lsid]) || "name_asc";
    opts.forEach(o=> sortSel.appendChild(el('option',{value:o,text:o, ...(o===def?{selected:""}:{})})));
    sortSel.addEventListener('change', ()=>{ prefs.perListSort = prefs.perListSort || {}; prefs.perListSort[lsid] = sortSel.value; });

    tr.appendChild(el('td',{},[cb]));
    tr.appendChild(nameCell);
    tr.appendChild(count);
    tr.appendChild(orderCell);
    tr.appendChild(el('td',{},[sortSel]));
    return tr;
  }

  order.forEach((lsid, i)=> tbody.appendChild(makeRow(lsid, i)));
  table.appendChild(tbody);

  container.appendChild(el('div', {html:'<b>Default list:</b> '}));
  const defSel = el('select');
  order.forEach(lsid => defSel.appendChild(el('option',{value:lsid,text:(lists[lsid].name||lsid), ...(lsid===prefs.defaultList?{selected:""}:{})})));
  container.appendChild(defSel);

  container.appendChild(el('div', {style:'margin-top:8px'}));
  const epCb = el('input',{type:'checkbox'}); epCb.checked = !!prefs.upgradeEpisodes;
  container.appendChild(epCb);
  container.appendChild(el('span',{text:' Upgrade episodes to parent series'}));

  container.appendChild(el('div',{style:'margin-top:10px'}));
  container.appendChild(table);

  const saveBtn = document.getElementById('saveBtn');
  const saveMsg = document.getElementById('saveMsg');
  saveBtn.onclick = async ()=>{
    const enabled = Array.from(enabledSet);
    const body = {
      enabled, order, defaultList: defSel.value, perListSort: prefs.perListSort || {}, upgradeEpisodes: epCb.checked
    };
    saveMsg.textContent = "Saving…";
    const r = await fetch('/api/prefs?admin=${ADMIN_PASSWORD}', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    const t = await r.text();
    saveMsg.textContent = t || "Saved.";
    setTimeout(()=>{ saveMsg.textContent = ""; }, 2500);
  };
}

render();
</script>
</body>
</html>`);
});

// API: lists (for admin JS)
app.get("/api/lists", (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  res.json(LISTS);
});

// API: prefs get/set
app.get("/api/prefs", (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  res.json(PREFS);
});

app.post("/api/prefs", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const body = req.body || {};
    PREFS.enabled         = Array.isArray(body.enabled) ? body.enabled.filter(isListId) : [];
    PREFS.order           = Array.isArray(body.order)   ? body.order.filter(isListId)   : [];
    PREFS.defaultList     = isListId(body.defaultList) ? body.defaultList : "";
    PREFS.perListSort     = body.perListSort && typeof body.perListSort === "object" ? body.perListSort : {};
    PREFS.upgradeEpisodes = !!body.upgradeEpisodes;

    // bump manifest so Stremio refreshes catalogs without reinstall
    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) {
      LAST_MANIFEST_KEY = key;
      MANIFEST_REV++;
    }

    // persist new prefs
    if (GH_ENABLED) {
      try {
        await ghWriteSnapshot({
          lastSyncAt: LAST_SYNC_AT,
          manifestRev: MANIFEST_REV,
          lists: LISTS,
          prefs: PREFS,
          fallback: Object.fromEntries(FALLBK),
          cards: Object.fromEntries(CARD),
          ep2ser: Object.fromEntries(EP2SER)
        });
      } catch (e) { /* ignore */ }
    }

    res.status(200).send("Saved. Manifest rev " + MANIFEST_REV);
  } catch (e) {
    console.error("prefs save error:", e);
    res.status(500).send("Failed to save");
  }
});

// Force sync
app.post("/api/sync", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    await fullSync({ rediscover: true });
    scheduleNextSync(true);
    res.status(200).send(`Synced at ${nowIso()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

// ----------------- BOOT -----------------
(async () => {
  await bootFromSnapshot();
  fullSync({ rediscover: true }).then(()=> scheduleNextSync(false));
  app.listen(PORT, HOST, () => {
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
  });
})();
