/*  My Lists – IMDb → Stremio (custom per-list ordering, IMDb date order, Trakt official/id lists, admin tabs + arrows)
 *  v12.4.1
 */
"use strict";
const express = require("express");
const fs = require("fs/promises");

// ----------------- ENV -----------------
const PORT  = Number(process.env.PORT || 7000);
const HOST  = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // https://www.imdb.com/user/urXXXXXXX/lists/
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));
const UPGRADE_EPISODES  = String(process.env.UPGRADE_EPISODES || "true").toLowerCase() !== "false";

// fetch IMDb’s own release-date page order so our date sort matches IMDb exactly
const IMDB_FETCH_RELEASE_ORDERS = String(process.env.IMDB_FETCH_RELEASE_ORDERS || "true").toLowerCase() !== "false";

// Optional fallback: comma-separated ls ids
const IMDB_LIST_IDS = (process.env.IMDB_LIST_IDS || "")
  .split(/[,\s]+/).map(s => s.trim()).filter(s => /^ls\d{6,}$/i.test(s));

// Optional GitHub snapshot persistence
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || "";
const GITHUB_OWNER  = process.env.GITHUB_OWNER  || "";
const GITHUB_REPO   = process.env.GITHUB_REPO   || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GH_ENABLED    = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);
const SNAP_LOCAL    = "data/snapshot.json";

// NEW: Trakt support (public API key / client id)
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID || "";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/12.4.1";
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};
const CINEMETA = "https://v3-cinemeta.strem.io";

// include "imdb" (raw list order) and mirror IMDb’s release-date order when available
const SORT_OPTIONS = [
  "custom","imdb",
  "date_asc","date_desc",
  "rating_asc","rating_desc",
  "runtime_asc","runtime_desc",
  "name_asc","name_desc"
];
const VALID_SORT = new Set(SORT_OPTIONS);

// ----------------- STATE -----------------
/** LISTS = {
 *   [listId]: {
 *     id, name, url,
 *     ids:[tt...],                 // default order (= IMDb/Trakt raw order after episode→series upgrade)
 *     orders: {                    // optional IMDb-backed orders we keep (for IMDb lists)
 *        imdb:[tt...],
 *        date_asc:[tt...],
 *        date_desc:[tt...]
 *     }
 *   }
 * }
 *
 * listId is either:
 *   - IMDb list:        "ls123456789"
 *   - Trakt user list:  "trakt:username:slug"     (legacy & still supported)
 *   - Trakt global/id:  "trakt:list:_id_{idOrSlug}"
 */
let LISTS = Object.create(null);

/** PREFS saved to snapshot */
let PREFS = {
  listEdits: {},          // { [listId]: { added: ["tt..."], removed: ["tt..."] } }
  enabled: [],            // listIds shown in Stremio
  order: [],              // listIds order in manifest
  defaultList: "",
  perListSort: {},        // { listId: 'date_asc' | ... | 'custom' }
  sortOptions: {},        // { listId: ['custom', 'date_desc', ...] }
  customOrder: {},        // { listId: [ 'tt...', 'tt...' ] }
  upgradeEpisodes: UPGRADE_EPISODES,
  sources: {              // extra sources you add in the UI
    users: [],            // array of IMDb user /lists URLs
    lists: []             // array of list URLs (IMDb or Trakt) or lsids
  },
  blocked: []             // listIds you removed/blocked (IMDb or Trakt)
};

const BEST   = new Map(); // Map<tt, { kind, meta }>
const FALLBK = new Map(); // Map<tt, { name?, poster?, releaseDate?, year?, type? }>
const EP2SER = new Map(); // Map<episode_tt, parent_series_tt>
const CARD   = new Map(); // Map<tt, card>

let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;

let MANIFEST_REV = 1;
let LAST_MANIFEST_KEY = "";

// ----------------- UTILS -----------------
const isImdb = v => /^tt\d{7,}$/i.test(String(v||""));

const isImdbListId = v => /^ls\d{6,}$/i.test(String(v||""));
const isTraktListId = v => /^trakt:[^:]+:[^:]+$/i.test(String(v||""));
const isListId = v => isImdbListId(v) || isTraktListId(v);

function makeTraktUserListKey(user, slug) {
  // legacy-compatible key for user lists
  return `trakt:${user}:${slug}`;
}
// NEW: key for Trakt "global/id" lists (numeric or slug from /lists/...)
function makeTraktIdListKey(id) {
  return `trakt:list:_id_${id}`;
}

/**
 * Decode a Trakt list key into a "spec" we can use to hit the right API endpoints.
 * Supports:
 *   - legacy "trakt:username:slug" → { mode:"user", user, slug }
 *   - new "trakt:list:_id_2435487" → { mode:"id", id:"2435487" }
 */
function parseTraktListKey(id) {
  const s = String(id || "");
  if (!s.startsWith("trakt:")) return null;

  // New ID-form: trakt:list:_id_something
  let m = s.match(/^trakt:list:(_id_(.+))$/i);
  if (m) {
    return { mode: "id", id: m[2] };
  }

  // Legacy user + slug form: trakt:username:slug
  m = s.match(/^trakt:([^:]+):(.+)$/i);
  if (m) {
    return { mode: "user", user: m[1], slug: m[2] };
  }
  return null;
}

// Parse raw Trakt list URLs from UI/env into specs
function parseTraktListUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // Normal user lists: https://trakt.tv/users/USER/lists/SLUG
  let m = s.match(/trakt\.tv\/users\/([^/]+)\/lists\/([^\/?#]+)/i);
  if (m) {
    return {
      mode: "user",
      user: decodeURIComponent(m[1]),
      slug: decodeURIComponent(m[2])
    };
  }

  // Official /lists/official/SLUG → treat as ID/slug
  m = s.match(/trakt\.tv\/lists\/official\/([^\/?#]+)/i);
  if (m) {
    return {
      mode: "id",
      id: decodeURIComponent(m[1])
    };
  }

  // Generic /lists/ID_OR_SLUG (e.g. /lists/2435487)
  m = s.match(/trakt\.tv\/lists\/([^\/?#]+)/i);
  if (m) {
    return {
      mode: "id",
      id: decodeURIComponent(m[1])
    };
  }

  return null;
}

const minutes = ms => Math.round(ms/60000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clampSortOptions = arr => (Array.isArray(arr) ? arr.filter(x => VALID_SORT.has(x)) : []);

async function fetchText(url) {
  const r = await fetch(url, { headers: REQ_HEADERS, redirect: "follow" });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept":"application/json" }, redirect:"follow" });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}
const withParam = (u,k,v) => { const x = new URL(u); x.searchParams.set(k,v); return x.toString(); };

// ---- GitHub snapshot (optional) ----
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
async function saveSnapshot(obj) {
  // local (best effort)
  try {
    await fs.mkdir("data", { recursive: true });
    await fs.writeFile(SNAP_LOCAL, JSON.stringify(obj, null, 2), "utf8");
  } catch {/* ignore */}
  // GitHub (if enabled)
  if (!GH_ENABLED) return;
  const content = Buffer.from(JSON.stringify(obj, null, 2)).toString("base64");
  const path = "data/snapshot.json";
  const sha = await ghGetSha(path);
  const body = { message: "Update snapshot.json", content, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  await gh("PUT", `/contents/${encodeURIComponent(path)}`, body);
}
async function loadSnapshot() {
  // try GitHub first
  if (GH_ENABLED) {
    try {
      const data = await gh("GET", `/contents/${encodeURIComponent("data/snapshot.json")}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
      const buf = Buffer.from(data.content, "base64").toString("utf8");
      return JSON.parse(buf);
    } catch {/* ignore */}
  }
  // local
  try {
    const txt = await fs.readFile(SNAP_LOCAL, "utf8");
    return JSON.parse(txt);
  } catch { return null; }
}

// ----------------- TRAKT HELPERS -----------------

async function traktJson(path) {
  if (!TRAKT_CLIENT_ID) throw new Error("TRAKT_CLIENT_ID not set");
  const url = `https://api.trakt.tv${path}`;
  const r = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": TRAKT_CLIENT_ID,
      "User-Agent": UA
    },
    redirect: "follow"
  });
  if (!r.ok) throw new Error(`Trakt ${path} -> ${r.status}`);
  try { return await r.json(); } catch { return null; }
}

/**
 * Fetch Trakt list meta (name + canonical URL) for either:
 *   - user list   → GET /users/{user}/lists/{slug}
 *   - id list     → GET /lists/{id}
 */
async function fetchTraktListMeta(spec) {
  if (!spec) return null;
  try {
    let data;
    if (spec.mode === "user") {
      data = await traktJson(`/users/${encodeURIComponent(spec.user)}/lists/${encodeURIComponent(spec.slug)}`);
      if (!data) return null;
      return {
        name: data.name || `${spec.user}/${spec.slug}`,
        url: `https://trakt.tv/users/${spec.user}/lists/${spec.slug}`
      };
    } else if (spec.mode === "id") {
      data = await traktJson(`/lists/${encodeURIComponent(spec.id)}`);
      if (!data) return null;
      const ids = data.ids || {};
      const slug = data.ids && data.ids.slug;
      // Prefer full canonical URL from data, fallback to /lists/{id}
      const url = slug
        ? `https://trakt.tv/lists/${slug}`
        : `https://trakt.tv/lists/${ids.trakt || spec.id}`;
      return {
        name: data.name || spec.id,
        url
      };
    }
  } catch (e) {
    console.warn("[TRAKT] list meta failed", spec, e.message);
  }
  return null;
}

/**
 * Fetch IMDb IDs from a Trakt list for either:
 *   - user lists: /users/{user}/lists/{slug}/items/{type}
 *   - id lists:   /lists/{id}/items/{type}
 */
async function fetchTraktListImdbIds(spec) {
  if (!spec) return [];
  const types = [
    { key: "movies",   prop: "movie"   },
    { key: "shows",    prop: "show"    },
    { key: "episodes", prop: "episode" }
  ];
  const out = [];
  const seen = new Set();

  for (const { key, prop } of types) {
    let page = 1;
    while (true) {
      let items;
      try {
        let path;
        if (spec.mode === "user") {
          path = `/users/${encodeURIComponent(spec.user)}/lists/${encodeURIComponent(spec.slug)}/items/${key}?page=${page}&limit=100`;
        } else if (spec.mode === "id") {
          path = `/lists/${encodeURIComponent(spec.id)}/items/${key}?page=${page}&limit=100`;
        } else {
          break;
        }
        items = await traktJson(path);
      } catch (e) {
        console.warn("[TRAKT] items fetch failed", spec, key, e.message);
        break;
      }
      if (!Array.isArray(items) || !items.length) break;

      for (const it of items) {
        const obj = it[prop];
        const ids = obj && obj.ids;
        let imdb = ids && ids.imdb;

        // For episodes, fall back to show imdb if needed
        if (!imdb && key === "episodes" && it.show && it.show.ids && it.show.ids.imdb) {
          imdb = it.show.ids.imdb;
        }

        if (imdb && isImdb(imdb) && !seen.has(imdb)) {
          seen.add(imdb);
          out.push(imdb);
        }
      }

      if (items.length < 100) break;
      page++;
      await sleep(80);
    }
  }

  return out;
}

// ----------------- IMDb DISCOVERY -----------------
function normalizeListIdOrUrl(s) {
  if (!s) return null;
  s = String(s).trim();
  const m = s.match(/ls\d{6,}/i);
  if (m) return { id: m[0], url: `https://www.imdb.com/list/${m[0]}/` };
  if (/imdb\.com\/list\//i.test(s)) return { id: null, url: s };
  return null;
}
async function discoverFromUserLists(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(withParam(userListsUrl, "_", Date.now()));
  const re = /href=['"](?:https?:\/\/(?:www\.)?imdb\.com)?\/list\/(ls\d{6,})\/['"]/gi;
  const ids = new Set(); let m;
  while ((m = re.exec(html))) ids.add(m[1]);
  if (!ids.size) {
    const re2 = /\/list\/(ls\d{6,})\//gi;
    while ((m = re2.exec(html))) ids.add(m[1]);
  }
  const arr = Array.from(ids).map(id => ({ id, url: `https://www.imdb.com/list/${id}/` }));
  await Promise.all(arr.map(async L => { try { L.name = await fetchListName(L.url); } catch { L.name = L.id; } }));
  return arr;
}
async function fetchListName(listUrl) {
  const html = await fetchText(withParam(listUrl, "_", Date.now()));
  const tries = [
    /<h1[^>]+data-testid=["']list-header-title["'][^>]*>(.*?)<\/h1>/i,
    /<h1[^>]*class=["'][^"']*header[^"']*["'][^>]*>(.*?)<\/h1>/i,
  ];
  for (const rx of tries) { const m = html.match(rx); if (m) return m[1].replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim(); }
  const t = html.match(/<title>(.*?)<\/title>/i);
  return t ? t[1].replace(/\s+\-\s*IMDb.*$/i,"").trim() : listUrl;
}
function tconstsFromHtml(html) {
  const out = []; const seen = new Set(); let m;
  const re1 = /data-tconst=["'](tt\d{7,})["']/gi;
  while ((m = re1.exec(html))) if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  const re2 = /\/title\/(tt\d{7,})\//gi;
  while ((m = re2.exec(html))) if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  return out;
}

/**
 * NEW multi-page implementation:
 * we explicitly request ?page=1,2,3… instead of scraping the “Next” button.
 */
async function fetchImdbListIdsAllPages(listUrl, maxPages = 80) {
  const seen = new Set();
  const ids = [];

  for (let page = 1; page <= maxPages; page++) {
    let url = withParam(listUrl, "mode", "detail");
    url = withParam(url, "page", String(page));
    let html;
    try {
      html = await fetchText(withParam(url, "_", Date.now()));
    } catch {
      break;
    }
    const found = tconstsFromHtml(html);
    let added = 0;
    for (const tt of found) {
      if (!seen.has(tt)) {
        seen.add(tt);
        ids.push(tt);
        added++;
      }
    }
    if (!added) break;
    await sleep(80);
  }
  return ids;
}

// fetch order IMDb shows when sorted a certain way – also using explicit ?page=N
async function fetchImdbOrder(listUrl, sortSpec /* e.g. "release_date,asc" */, maxPages = 80) {
  const seen = new Set();
  const ids = [];

  for (let page = 1; page <= maxPages; page++) {
    let url = withParam(listUrl, "mode", "detail");
    url = withParam(url, "sort", sortSpec);
    url = withParam(url, "page", String(page));
    let html;
    try {
      html = await fetchText(withParam(url, "_", Date.now()));
    } catch {
      break;
    }
    const found = tconstsFromHtml(html);
    let added = 0;
    for (const tt of found) {
      if (!seen.has(tt)) {
        seen.add(tt);
        ids.push(tt);
        added++;
      }
    }
    if (!added) break;
    await sleep(80);
  }
  return ids;
}

// ----------------- METADATA -----------------
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
async function getBestMeta(imdbId) {
  if (BEST.has(imdbId)) return BEST.get(imdbId);
  let meta = await fetchCinemeta("series", imdbId);
  if (meta) { const rec = { kind: "series", meta }; BEST.set(imdbId, rec); return rec; }
  meta = await fetchCinemeta("movie", imdbId);
  if (meta) { const rec = { kind: "movie", meta }; BEST.set(imdbId, rec); return rec; }
  const ld = await imdbJsonLd(imdbId);
  let name, poster, background, released, year, type = "movie";
  try {
    const node = Array.isArray(ld && ld["@graph"])
      ? ld["@graph"].find(x => x["@id"]?.includes(`/title/${imdbId}`)) || ld["@graph"][0]
      : ld;
    name = node?.name || node?.headline || ld?.name;
    poster = typeof node?.image === "string" ? node.image : (node?.image?.url || ld?.image);
    background = poster; // we don't have separate background via ld; reuse poster
    released = node?.datePublished || node?.startDate || node?.releaseDate || undefined;
    year = released ? Number(String(released).slice(0,4)) : undefined;
    const t = Array.isArray(node?.["@type"]) ? node["@type"].join(",") : (node?.["@type"] || "");
    if (/Series/i.test(t)) type = "series";
    else if (/TVEpisode/i.test(t)) type = "episode";
  } catch {}
  const rec = { kind: type === "series" ? "series" : "movie", meta: name ? { name, poster, background, released, year } : null };
  BEST.set(imdbId, rec);
  if (name || poster) FALLBK.set(imdbId, { name, poster, releaseDate: released, year, type: rec.kind });
  return rec;
}

// central place to build a "card" for admin + catalogs
function cardFor(imdbId) {
  const rec = BEST.get(imdbId) || { kind: null, meta: null };
  const m = rec.meta || {};
  const fb = FALLBK.get(imdbId) || {};

  const poster = m.poster || fb.poster || m.background || m.backdrop;
  const background = m.background || m.backdrop || poster || fb.poster;

  return {
    id: imdbId,
    type: rec.kind || fb.type || "movie",
    name: m.name || fb.name || imdbId,
    poster: poster || undefined,
    background: background || undefined,
    imdbRating: m.imdbRating ?? undefined,
    runtime: m.runtime ?? undefined,
    year: m.year ?? fb.year ?? undefined,
    releaseDate: m.released || m.releaseInfo || fb.releaseDate || undefined,
    description: m.description || undefined
  };
}

function toTs(d,y){ if(d){const t=Date.parse(d); if(!Number.isNaN(t)) return t;} if(y){const t=Date.parse(`${y}-01-01`); if(!Number.isNaN(t)) return t;} return null; }
function stableSort(items, sortKey) {
  const s = String(sortKey || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const key = s.split("_")[0];
  const cmpNullBottom = (a,b) => (a==null && b==null)?0 : (a==null?1 : (b==null?-1 : (a<b?-1:(a>b?1:0))));
  return items.map((m,i)=>({m,i})).sort((A,B)=>{
    const a=A.m,b=B.m; let c=0;
    if (key==="date") c = cmpNullBottom(toTs(a.releaseDate,a.year), toTs(b.releaseDate,b.year));
    else if (key==="rating") c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
    else if (key==="runtime") c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
    else c = (a.name||"").localeCompare(b.name||"");
    if (c===0){ c=(a.name||"").localeCompare(b.name||""); if(c===0) c=(a.id||"").localeCompare(b.id||""); if(c===0) c=A.i-B.i; }
    return c*dir;
  }).map(x=>x.m);
}
function applyCustomOrder(metas, lsid) {
  const order = (PREFS.customOrder && PREFS.customOrder[lsid]) || [];
  if (!order || !order.length) return metas.slice();
  const pos = new Map(order.map((id, i) => [id, i]));
  return metas.slice().sort((a, b) => {
    const pa = pos.has(a.id) ? pos.get(a.id) : Number.MAX_SAFE_INTEGER;
    const pb = pos.has(b.id) ? pos.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return (a.name||"").localeCompare(b.name||"");
  });
}
// order helper (imdb/date_asc/date_desc) backed by LISTS[lsid].orders
function sortByOrderKey(metas, lsid, key) {
  const list = LISTS[lsid];
  if (!list) return metas.slice();
  const arr =
    (list.orders && Array.isArray(list.orders[key]) && list.orders[key].length)
      ? list.orders[key]
      : (key === "imdb" ? (list.ids || []) : null);
  if (!arr) return metas.slice();
  const pos = new Map(arr.map((id, i) => [id, i]));
  return metas.slice().sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
}

// ----------------- SYNC -----------------
function manifestKey() {
  const enabled = (PREFS.enabled && PREFS.enabled.length) ? PREFS.enabled : Object.keys(LISTS);
  const names   = enabled.map(id => LISTS[id]?.name || id).sort().join("|");
  const perSort = JSON.stringify(PREFS.perListSort || {});
  const perOpts = JSON.stringify(PREFS.sortOptions || {});
  const custom  = Object.keys(PREFS.customOrder || {}).length;
  const order   = (PREFS.order || []).join(",");

  return `${enabled.join(",")}#${order}#${PREFS.defaultList}#${names}#${perSort}#${perOpts}#c${custom}`;
}

async function harvestSources() {
  const blocked = new Set(PREFS.blocked || []);
  const map = new Map();

  const add = (d) => {
    if (!d || !d.id) return;
    if (blocked.has(d.id)) return;
    if (!d.name) d.name = d.id;
    map.set(d.id, d);
  };

  // 1) IMDb main user /lists (auto-discovery)
  if (IMDB_USER_URL) {
    try {
      const arr = await discoverFromUserLists(IMDB_USER_URL);
      arr.forEach(add);
    } catch (e) {
      console.warn("[DISCOVER] main failed:", e.message);
    }
  }

  // 2) extra IMDb user /lists URLs from prefs
  const users = Array.from(
    new Set((PREFS.sources?.users || []).map(s => String(s).trim()).filter(Boolean))
  );
  for (const u of users) {
    try {
      const arr = await discoverFromUserLists(u);
      arr.forEach(add);
    } catch (e) {
      console.warn("[DISCOVER] user", u, "failed:", e.message);
    }
    await sleep(80);
  }

  // 3) explicit list URLs or IDs (IMDb or Trakt) + IMDB_LIST_IDS fallback
  const addlRaw = (PREFS.sources?.lists || []).concat(IMDB_LIST_IDS || []);
  for (const raw of addlRaw) {
    const val = String(raw || "").trim();
    if (!val) continue;

    // ---- Trakt lists (user, official, id) ----
    const tinfo = parseTraktListUrl(val);
    if (tinfo) {
      if (!TRAKT_CLIENT_ID) {
        console.warn("[TRAKT] got list", val, "but TRAKT_CLIENT_ID is not set – ignoring.");
        continue;
      }

      const key = (tinfo.mode === "user")
        ? makeTraktUserListKey(tinfo.user, tinfo.slug)
        : makeTraktIdListKey(tinfo.id);

      if (blocked.has(key)) continue;

      let name = key;
      let url  = val;
      try {
        const meta = await fetchTraktListMeta(tinfo);
        if (meta) {
          if (meta.name) name = meta.name;
          if (meta.url)  url = meta.url;
        }
      } catch (e) {
        console.warn("[TRAKT] meta fetch failed for", val, e.message);
      }

      add({ id: key, url, name });
      await sleep(60);
      continue;
    }

    // ---- IMDb lists ----
    const norm = normalizeListIdOrUrl(val);
    if (!norm) continue;
    let { id, url } = norm;
    if (!id) {
      const m = String(url).match(/ls\d{6,}/i);
      if (m) id = m[0];
    }
    if (!id) continue;

    let name = id;
    try { name = await fetchListName(url); } catch { /* ignore */ }

    add({ id, url, name });
    await sleep(60);
  }

  return Array.from(map.values());
}

async function fullSync({ rediscover = true } = {}) {
  if (syncInProgress) return;
  syncInProgress = true;
  const started = Date.now();
  try {
    let discovered = [];
    if (rediscover) {
      discovered = await harvestSources();
    }
    if ((!discovered || !discovered.length) && IMDB_LIST_IDS.length) {
      discovered = IMDB_LIST_IDS.map(id => ({ id, name: id, url: `https://www.imdb.com/list/${id}/` }));
      console.log(`[DISCOVER] used IMDB_LIST_IDS fallback (${discovered.length})`);
    }

    const next = Object.create(null);
    const seen = new Set();
    for (const d of discovered) {
      next[d.id] = {
        id: d.id,
        name: d.name || d.id,
        url: d.url,
        ids: [],
        orders: d.orders || {}
      };
      seen.add(d.id);
    }
    const blocked = new Set(PREFS.blocked || []);
    for (const id of Object.keys(LISTS)) {
      if (!seen.has(id) && !blocked.has(id)) next[id] = LISTS[id];
    }

    // pull items for each list (IMDb or Trakt)
    const uniques = new Set();
    for (const id of Object.keys(next)) {
      const list = next[id];
      let raw = [];

      if (isTraktListId(id)) {
        const spec = parseTraktListKey(id);
        if (spec && TRAKT_CLIENT_ID) {
          try {
            raw = await fetchTraktListImdbIds(spec);
          } catch (e) {
            console.warn("[SYNC] Trakt fetch failed for", id, e.message);
          }
        }
      } else {
        const url = list.url || `https://www.imdb.com/list/${id}/`;
        try {
          raw = await fetchImdbListIdsAllPages(url);
        } catch (e) {
          console.warn("[SYNC] IMDb list fetch failed for", id, e.message);
        }

        if (IMDB_FETCH_RELEASE_ORDERS && isImdbListId(id)) {
          try {
            const asc  = await fetchImdbOrder(url, "release_date,asc");
            const desc = await fetchImdbOrder(url, "release_date,desc");
            list.orders = list.orders || {};
            list.orders.date_asc  = asc.slice();
            list.orders.date_desc = desc.slice();
            asc.forEach(tt => uniques.add(tt));
            desc.forEach(tt => uniques.add(tt));
          } catch (e) {
            console.warn("[SYNC] release_date sort fetch failed for", id, e.message);
          }
        }
      }

      list.ids = raw.slice();
      raw.forEach(tt => uniques.add(tt));
      await sleep(60);
    }

    // episode → series (optional)
    let idsToPreload = Array.from(uniques);
    if (PREFS.upgradeEpisodes) {
      const up = new Set();
      for (const tt of idsToPreload) {
        const rec = await getBestMeta(tt);
        if (!rec.meta) {
          const s = await episodeParentSeries(tt);
          up.add(s && isImdb(s) ? s : tt);
        } else up.add(tt);
      }
      idsToPreload = Array.from(up);

      const remap = (arr) => {
        if (!Array.isArray(arr)) return [];
        const out = []; const S = new Set();
        for (const tt of arr) {
          let fin = tt;
          const r = BEST.get(tt);
          if (!r || !r.meta) { const z = EP2SER.get(tt); if (z) fin = z; }
          if (!S.has(fin)) { S.add(fin); out.push(fin); }
        }
        return out;
      };

      for (const id of Object.keys(next)) {
        next[id].ids = remap(next[id].ids);
        next[id].orders = next[id].orders || {};
        if (next[id].orders.date_asc)  next[id].orders.date_asc  = remap(next[id].orders.date_asc);
        if (next[id].orders.date_desc) next[id].orders.date_desc = remap(next[id].orders.date_desc);
        next[id].orders.imdb = next[id].ids.slice();
      }
    } else {
      for (const id of Object.keys(next)) {
        next[id].orders = next[id].orders || {};
        next[id].orders.imdb = next[id].ids.slice();
      }
    }

    // preload cards
    for (const tt of idsToPreload) {
      await getBestMeta(tt);
      CARD.set(tt, cardFor(tt));
    }

    LISTS = next;
    LAST_SYNC_AT = Date.now();

    // ensure prefs.order stability
    const allIds   = Object.keys(LISTS);
    const keep     = Array.isArray(PREFS.order) ? PREFS.order.filter(id => LISTS[id]) : [];
    const missingO = allIds.filter(id => !keep.includes(id));
    PREFS.order    = keep.concat(missingO);

    if (Array.isArray(PREFS.enabled) && PREFS.enabled.length) {
      PREFS.enabled = PREFS.enabled.filter(id => LISTS[id]);
    }

    const valid = new Set(Object.keys(LISTS));
    if (PREFS.customOrder) {
      for (const k of Object.keys(PREFS.customOrder)) if (!valid.has(k)) delete PREFS.customOrder[k];
    }

    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) {
      LAST_MANIFEST_KEY = key;
      MANIFEST_REV++;
      console.log("[SYNC] catalogs changed → manifest rev", MANIFEST_REV);
    }

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER)
    });

    console.log(`[SYNC] ok – ${Object.values(LISTS).reduce((n,L)=>n+(L.ids?.length||0),0)} items across ${Object.keys(LISTS).length} lists in ${minutes(Date.now()-started)} min`);
  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    syncInProgress = false;
  }
}
function scheduleNextSync() {
  if (syncTimer) clearTimeout(syncTimer);
  if (IMDB_SYNC_MINUTES <= 0) return;
  syncTimer = setTimeout(() => fullSync({ rediscover:true }).then(scheduleNextSync), IMDB_SYNC_MINUTES*60*1000);
}
function maybeBackgroundSync() {
  if (IMDB_SYNC_MINUTES <= 0) return;
  const stale = Date.now() - LAST_SYNC_AT > IMDB_SYNC_MINUTES*60*1000;
  if (stale && !syncInProgress) fullSync({ rediscover:true }).then(scheduleNextSync);
}

// ----------------- SERVER -----------------
const app = express();
app.use((_, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });
app.use(express.json({ limit: "1mb" }));

function addonAllowed(req){
  if (!SHARED_SECRET) return true;
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return u.searchParams.get("key") === SHARED_SECRET;
}
function adminAllowed(req){
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return (u.searchParams.get("admin") || req.headers["x-admin-key"]) === ADMIN_PASSWORD;
}
const absoluteBase = req => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
};

app.get("/health", (_,res)=>res.status(200).send("ok"));

// ------- Manifest -------
const baseManifest = {
  id: "org.mylists.snapshot",
  version: "12.4.1",
  name: "My Lists",
  description: "Your IMDb & Trakt lists as catalogs (cached).",
  resources: ["catalog","meta"],
  types: ["my lists","movie","series"],
  idPrefixes: ["tt"],
  behaviorHints: {
    configurable: true,
    configurationRequired: false
  }
};

function getEnabledOrderedIds() {
  const allIds  = Object.keys(LISTS);
  const enabled = new Set(PREFS.enabled && PREFS.enabled.length ? PREFS.enabled : allIds);
  const base    = (PREFS.order && PREFS.order.length ? PREFS.order.filter(id => LISTS[id]) : []);
  const missing = allIds.filter(id => !base.includes(id))
    .sort((a,b)=>( (LISTS[a]?.name||a).localeCompare(LISTS[b]?.name||b) ));
  const ordered = base.concat(missing);
  return ordered.filter(id => enabled.has(id));
}
function catalogs(){
  const ids = getEnabledOrderedIds();
  return ids.map(lsid => ({
    type: "my lists",
    id: `list:${lsid}`,
    name: `🗂 ${LISTS[lsid]?.name || lsid}`,
    extraSupported: ["search","skip","limit","sort"],
    extra: [
      { name:"search" }, { name:"skip" }, { name:"limit" },
      { name:"sort", options: (PREFS.sortOptions && PREFS.sortOptions[lsid] && PREFS.sortOptions[lsid].length) ? PREFS.sortOptions[lsid] : SORT_OPTIONS }
    ]
    // no posterShape – Stremio uses default poster style
  }));
}
app.get("/manifest.json", (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();
    const version = `${baseManifest.version}-${MANIFEST_REV}`;
    res.json({
      ...baseManifest,
      version,
      catalogs: catalogs(),
      configuration: `${absoluteBase(req)}/configure`
    });
  }catch(e){ console.error("manifest:", e); res.status(500).send("Internal Server Error");}
});

app.get("/configure", (req, res) => {
  const base = absoluteBase(req);
  const dest = `${base}/admin?admin=${encodeURIComponent(ADMIN_PASSWORD)}`;

  res.type("html").send(`
    <!doctype html><meta charset="utf-8">
    <title>Configure – My Lists</title>
    <meta http-equiv="refresh" content="0; url='${dest}'">
    <style>
      body{font-family:system-ui; background:#0f0d1a; color:#f7f7fb;
           display:grid; place-items:center; height:100vh; margin:0}
      a{color:#9aa0b4;}
    </style>
    <p>Opening admin… <a href="${dest}">continue</a></p>
  `);
});

// ------- Catalog -------
function parseExtra(extraStr, qObj){
  const p = new URLSearchParams(extraStr||"");
  return { ...Object.fromEntries(p.entries()), ...(qObj||{}) };
}
app.get("/catalog/:type/:id/:extra?.json", (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const { id } = req.params;
    if (!id || !id.startsWith("list:")) return res.json({ metas: [] });
    const lsid = id.slice(5);
    const list = LISTS[lsid];
    if (!list) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q = String(extra.search||"").toLowerCase().trim();
    const sortReq = String(extra.sort||"").toLowerCase();
    const defaultSort = (PREFS.perListSort && PREFS.perListSort[lsid]) || "name_asc";
    const sort = sortReq || defaultSort;
    const skip = Math.max(0, Number(extra.skip||0));
    const limit = Math.min(Number(extra.limit||100), 200);

    // apply per-list edits (immediate effect)
    let ids = (list.ids || []).slice();
    const ed = (PREFS.listEdits && PREFS.listEdits[lsid]) || {};
    const removed = new Set((ed.removed || []).filter(isImdb));
    if (removed.size) ids = ids.filter(tt => !removed.has(tt));
    const toAdd = (ed.added || []).filter(isImdb);
    for (const tt of toAdd) if (!ids.includes(tt)) ids.push(tt);

    let metas = ids.map(tt => CARD.get(tt) || cardFor(tt));

    if (q) {
      metas = metas.filter(m =>
        (m.name||"").toLowerCase().includes(q) ||
        (m.id||"").toLowerCase().includes(q) ||
        (m.description||"").toLowerCase().includes(q)
      );
    }

    if (sort === "custom") metas = applyCustomOrder(metas, lsid);
    else if (sort === "imdb") metas = sortByOrderKey(metas, lsid, "imdb");
    else if (sort === "date_asc" || sort === "date_desc") {
      const haveImdbOrder = LISTS[lsid]?.orders && Array.isArray(LISTS[lsid].orders[sort]) && LISTS[lsid].orders[sort].length;
      metas = haveImdbOrder ? sortByOrderKey(metas, lsid, sort) : stableSort(metas, sort);
    } else metas = stableSort(metas, sort);

    // No poster-shape swap; meta already has a single poster field
    res.json({ metas: metas.slice(skip, skip+limit) });
  }catch(e){ console.error("catalog:", e); res.status(500).send("Internal Server Error"); }
});

// ------- Meta -------
app.get("/meta/:type/:id.json", async (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const imdbId = req.params.id;
    if (!isImdb(imdbId)) return res.json({ meta:{ id: imdbId, type:"movie", name:"Unknown item" } });

    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);
    if (!rec || !rec.meta) {
      const fb = FALLBK.get(imdbId) || {};
      return res.json({ meta: { id: imdbId, type: rec?.kind || fb.type || "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
    }

    const m = rec.meta;
    res.json({
      meta: {
        ...m,
        id: imdbId,
        type: rec.kind
      }
    });
  }catch(e){ console.error("meta:", e); res.status(500).send("Internal Server Error"); }
});

// ------- Admin + debug & new endpoints -------
app.get("/api/lists", (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  res.json(LISTS);
});
app.get("/api/prefs", (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  res.json(PREFS);
});
app.post("/api/prefs", async (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const body = req.body || {};
    PREFS.enabled         = Array.isArray(body.enabled) ? body.enabled.filter(isListId) : [];
    PREFS.order           = Array.isArray(body.order)   ? body.order.filter(isListId)   : [];
    PREFS.defaultList     = isListId(body.defaultList) ? body.defaultList : "";
    PREFS.perListSort     = body.perListSort && typeof body.perListSort === "object" ? body.perListSort : (PREFS.perListSort || {});
    PREFS.sortOptions     = body.sortOptions && typeof body.sortOptions === "object"
      ? Object.fromEntries(Object.entries(body.sortOptions).map(([k,v])=>[k,clampSortOptions(v)]))
      : (PREFS.sortOptions || {});

    PREFS.upgradeEpisodes = !!body.upgradeEpisodes;

    if (body.customOrder && typeof body.customOrder === "object") {
      PREFS.customOrder = body.customOrder;
    }

    const src = body.sources || {};
    PREFS.sources = {
      users: Array.isArray(src.users) ? src.users.map(s=>String(s).trim()).filter(Boolean) : (PREFS.sources.users || []),
      lists: Array.isArray(src.lists) ? src.lists.map(s=>String(s).trim()).filter(Boolean) : (PREFS.sources.lists || [])
    };

    PREFS.blocked = Array.isArray(body.blocked) ? body.blocked.filter(isListId) : (PREFS.blocked || []);

    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) { LAST_MANIFEST_KEY = key; MANIFEST_REV++; }

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER)
    });

    res.status(200).send("Saved. Manifest rev " + MANIFEST_REV);
  }catch(e){ console.error("prefs save error:", e); res.status(500).send("Failed to save"); }
});

// unblock a previously removed list
app.post("/api/unblock-list", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid||"");
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    PREFS.blocked = (PREFS.blocked || []).filter(id => id !== lsid);
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send("Unblocked & synced");
  }catch(e){ console.error(e); res.status(500).send("Failed"); }
});

// return cards for one list (for the drawer) — includes edits
app.get("/api/list-items", (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  const lsid = String(req.query.lsid || "");
  const list = LISTS[lsid];
  if (!list) return res.json({ items: [] });

  let ids = (list.ids || []).slice();
  const ed = (PREFS.listEdits && PREFS.listEdits[lsid]) || {};
  const removed = new Set((ed.removed || []).filter(isImdb));
  if (removed.size) ids = ids.filter(tt => !removed.has(tt));
  const toAdd = (ed.added || []).filter(isImdb);
  for (const tt of toAdd) if (!ids.includes(tt)) ids.push(tt);

  const items = ids.map(tt => CARD.get(tt) || cardFor(tt));

  res.json({ items });
});

// add an item (tt...) to a list
app.post("/api/list-add", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lsid = String(req.body.lsid || "");
    let tt = String(req.body.id || "").trim();
    const m = tt.match(/tt\d{7,}/i);
    if (!isListId(lsid) || !m) return res.status(400).send("Bad input");
    tt = m[0];

    PREFS.listEdits = PREFS.listEdits || {};
    const ed = PREFS.listEdits[lsid] || (PREFS.listEdits[lsid] = { added: [], removed: [] });
    if (!ed.added.includes(tt)) ed.added.push(tt);
    ed.removed = (ed.removed || []).filter(x => x !== tt);

    await getBestMeta(tt);
    CARD.set(tt, cardFor(tt));

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER)
    });

    res.status(200).send("Added");
  } catch (e) { console.error(e); res.status(500).send("Failed"); }
});

// remove an item (tt...) from a list
app.post("/api/list-remove", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lsid = String(req.body.lsid || "");
    let tt = String(req.body.id || "").trim();
    const m = tt.match(/tt\d{7,}/i);
    if (!isListId(lsid) || !m) return res.status(400).send("Bad input");
    tt = m[0];

    PREFS.listEdits = PREFS.listEdits || {};
    const ed = PREFS.listEdits[lsid] || (PREFS.listEdits[lsid] = { added: [], removed: [] });

    if (!ed.removed.includes(tt)) ed.removed.push(tt);
    ed.added = (ed.added || []).filter(x => x !== tt);

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER)
    });

    res.status(200).send("Removed");
  } catch (e) { console.error(e); res.status(500).send("Failed"); }
});

// clear custom order and all add/remove edits for a list
app.post("/api/list-reset", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lsid = String(req.body.lsid || "");
    if (!isListId(lsid)) return res.status(400).send("Bad input");
    if (PREFS.customOrder) delete PREFS.customOrder[lsid];
    if (PREFS.listEdits) delete PREFS.listEdits[lsid];

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER)
    });

    res.status(200).send("Reset");
  } catch (e) { console.error(e); res.status(500).send("Failed"); }
});

// save a per-list custom order and set default sort=custom
app.post("/api/custom-order", async (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid || "");
    const order = Array.isArray(req.body.order) ? req.body.order.filter(isImdb) : [];
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    const list = LISTS[lsid];
    if (!list) return res.status(404).send("List not found");

    const set = new Set(list.ids.concat(PREFS.listEdits?.[lsid]?.added || []));
    const clean = order.filter(id => set.has(id));

    PREFS.customOrder = PREFS.customOrder || {};
    PREFS.customOrder[lsid] = clean;
    PREFS.perListSort = PREFS.perListSort || {};
    PREFS.perListSort[lsid] = "custom";

    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) { LAST_MANIFEST_KEY = key; MANIFEST_REV++; }

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER)
    });

    res.status(200).json({ ok:true, manifestRev: MANIFEST_REV });
  }catch(e){ console.error("custom-order:", e); res.status(500).send("Failed"); }
});

// add sources quickly then sync
app.post("/api/add-sources", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const users = Array.isArray(req.body.users) ? req.body.users.map(s=>String(s).trim()).filter(Boolean) : [];
    const lists = Array.isArray(req.body.lists) ? req.body.lists.map(s=>String(s).trim()).filter(Boolean) : [];
    PREFS.sources = PREFS.sources || { users:[], lists:[] };
    PREFS.sources.users = Array.from(new Set([ ...(PREFS.sources.users||[]), ...users ]));
    PREFS.sources.lists = Array.from(new Set([ ...(PREFS.sources.lists||[]), ...lists ]));
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send("Sources added & synced");
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});

// remove/block a list
app.post("/api/remove-list", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid||"");
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    delete LISTS[lsid];
    PREFS.enabled = (PREFS.enabled||[]).filter(id => id!==lsid);
    PREFS.order   = (PREFS.order||[]).filter(id => id!==lsid);
    PREFS.blocked = Array.from(new Set([ ...(PREFS.blocked||[]), lsid ]));

    LAST_MANIFEST_KEY = ""; MANIFEST_REV++; // force bump
    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER)
    });
    res.status(200).send("Removed & blocked");
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});

app.post("/api/sync", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send(`Synced at ${new Date().toISOString()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});
app.post("/api/purge-sync", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    LISTS = Object.create(null);
    BEST.clear(); FALLBK.clear(); EP2SER.clear(); CARD.clear();
    PREFS.customOrder = PREFS.customOrder || {};
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send(`Purged & synced at ${new Date().toISOString()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});

app.get("/api/debug-imdb", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const url = IMDB_USER_URL || req.query.u;
    if (!url) return res.type("text").send("IMDB_USER_URL not set.");
    const html = await fetchText(withParam(url,"_","dbg"));
    res.type("text").send(html.slice(0,2000));
  }catch(e){ res.type("text").status(500).send("Fetch failed: "+e.message); }
});

// ------- Admin page (tabs: Snapshot / Add Lists / Customize) -------
app.get("/admin", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  const base = absoluteBase(req);
  const manifestUrl = `${base}/manifest.json${SHARED_SECRET?`?key=${SHARED_SECRET}`:""}`;

  let discovered = [];
  try { discovered = await harvestSources(); } catch {}

  const rows = Object.keys(LISTS).map(id => {
    const L = LISTS[id]; const count=(L.ids||[]).length;
    return `<li><b>${L.name||id}</b> <small>(${count} items)</small><br/><small>${L.url||""}</small></li>`;
  }).join("") || "<li>(none)</li>";

  const disc = discovered.map(d=>`<li><b>${d.name||d.id}</b><br/><small>${d.url}</small></li>`).join("") || "<li>(none)</li>";

  const lastSyncText = LAST_SYNC_AT
    ? (new Date(LAST_SYNC_AT).toLocaleString() + " (" + Math.round((Date.now()-LAST_SYNC_AT)/60000) + " min ago)")
    : "never";

  res.type("html").send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Admin</title>
<style>
  :root{
    color-scheme:light;
    --bg:#050415;
    --bg2:#0f0d1a;
    --card:#141129;
    --muted:#9aa0b4;
    --text:#f7f7fb;
    --accent:#6c5ce7;
    --accent2:#8b7cf7;
    --accent-soft:rgba(108,92,231,.18);
    --border:#262145;
    --danger:#ff7675;
  }
  body{
    font-family:system-ui,Segoe UI,Roboto,Arial;
    margin:0;
    background:radial-gradient(circle at top,#2f2165 0,#050415 48%,#02010a 100%);
    color:var(--text);
    min-height:100vh;
  }
  .wrap{
    max-width:1100px;
    margin:0 auto;
    padding:20px 16px 32px;
  }
  .hero{padding:6px 0 12px;text-align:center}
  h1{margin:0 0 4px;font-weight:700;font-size:26px;letter-spacing:.01em}
  .subtitle{color:var(--muted);font-size:14px}
  .tabs{
    display:flex;
    justify-content:center;
    gap:8px;
    margin-top:16px;
    margin-bottom:10px;
    flex-wrap:wrap;
  }
  .tab-btn{
    padding:7px 14px;
    border-radius:999px;
    border:1px solid transparent;
    background:rgba(15,13,36,.6);
    color:var(--muted);
    cursor:pointer;
    font-size:13px;
    display:inline-flex;
    align-items:center;
    gap:6px;
  }
  .tab-btn.active{
    background:var(--accent);
    color:#fff;
    border-color:rgba(255,255,255,.15);
    box-shadow:0 6px 18px rgba(108,92,231,.55);
  }
  .section{
    display:none;
    margin-top:8px;
  }
  .section.active{display:block;}
  .card{
    border:1px solid var(--border);
    border-radius:18px;
    padding:16px 18px;
    background:linear-gradient(145deg,rgba(17,14,39,.96),rgba(8,6,25,.98));
    box-shadow:0 18px 40px rgba(0,0,0,.55);
    margin-bottom:14px;
  }
  h3{margin:0 0 8px;font-size:17px}
  h4{margin:10px 0 4px;font-size:14px}
  button{
    padding:9px 14px;
    border:0;
    border-radius:999px;
    background:var(--accent);
    color:#fff;
    cursor:pointer;
    font-size:13px;
    display:inline-flex;
    align-items:center;
    gap:6px;
    box-shadow:0 6px 16px rgba(108,92,231,.55);
  }
  button.btn2{background:var(--accent2);}
  button:disabled{opacity:.5;cursor:default;box-shadow:none}
  small{color:var(--muted)}
  .code{
    font-family:ui-monospace,Menlo,Consolas,monospace;
    background:#1c1837;
    color:#d6d3ff;
    padding:4px 6px;
    border-radius:6px;
    font-size:12px;
    word-break:break-all;
  }
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
  th,td{padding:8px 6px;border-bottom:1px solid rgba(38,33,69,.8);text-align:left;vertical-align:top}
  th{font-weight:600;color:#d7d1ff;font-size:12px}
  tr:hover td{background:rgba(17,14,40,.7);}
  .muted{color:var(--muted)}
  .chev{cursor:pointer;font-size:16px;line-height:1;user-select:none}
  .drawer{background:#120f25}
  .thumbs{
    display:grid;
    grid-template-columns:repeat(auto-fill,minmax(220px,1fr));
    gap:10px;
    margin:12px 0;
    padding:0;
    list-style:none;
  }
  .thumb{
    position:relative;
    display:flex;
    gap:10px;
    align-items:center;
    border:1px solid var(--border);
    background:#1a1636;
    border-radius:12px;
    padding:6px 8px;
  }
  .thumb-img{
    object-fit:cover;
    border-radius:6px;
    background:#2a244e;
    flex-shrink:0;
    width:52px;
    height:78px;
  }
  .thumb .title{font-size:14px}
  .thumb .id{font-size:11px;color:var(--muted)}
  .thumb[draggable="true"]{cursor:grab}
  .thumb.dragging{opacity:.5}
  .thumb .del{
    position:absolute;
    top:6px;
    right:6px;
    width:20px;
    height:20px;
    line-height:20px;
    text-align:center;
    border-radius:999px;
    background:#3a2c2c;
    color:#ffb4b4;
    font-weight:700;
    display:none;
  }
  .thumb:hover .del{display:block}
  .thumb.add{
    align-items:center;
    justify-content:center;
    border:1px dashed var(--border);
    min-height:90px;
  }
  .addbox{width:100%;text-align:center}
  .addbox input{
    margin-top:6px;
    width:100%;
    box-sizing:border-box;
    background:#1c1837;
    color:var(--text);
    border:1px solid var(--border);
    border-radius:8px;
    padding:8px;
  }
  .rowtools{
    display:flex;
    flex-wrap:wrap;
    gap:8px;
    align-items:center;
    margin-bottom:8px;
    margin-top:4px;
  }
  .inline-note{font-size:12px;color:var(--muted);margin-left:8px}
  .pill{
    display:inline-flex;
    align-items:center;
    gap:8px;
    background:#1c1837;
    border:1px solid var(--border);
    border-radius:999px;
    padding:4px 9px;
    color:#dcd8ff;
    font-size:12px;
    margin:2px 4px 2px 0;
  }
  .pill input{margin-right:4px}
  .pill .x{cursor:pointer;color:#ffb4b4;font-size:11px}
  input[type="text"]{
    background:#1c1837;
    color:var(--text);
    border:1px solid var(--border);
    border-radius:8px;
    padding:8px 9px;
    width:100%;
    font-size:13px;
  }
  .row{
    display:grid;
    gap:10px;
    grid-template-columns:1fr 110px;
    margin-bottom:8px;
  }
  .mini{font-size:12px}
  a.link{color:#b1b9ff;text-decoration:none}
  a.link:hover{text-decoration:underline}
  .installRow{
    display:flex;
    flex-wrap:wrap;
    gap:8px;
    align-items:center;
    margin-top:8px;
  }
  /* Reorder buttons */
  .move-col{
    white-space:nowrap;
  }
  .move-btn{
    padding:3px 6px;
    border-radius:999px;
    border:1px solid rgba(255,255,255,.18);
    background:#1c1837;
    color:#dcd8ff;
    font-size:11px;
    box-shadow:none;
    margin:0 2px;
  }
  .thumb-move{
    margin-left:auto;
    display:flex;
    flex-direction:column;
    gap:4px;
  }
  .thumb-move .move-btn{
    padding:2px 6px;
    font-size:11px;
  }
</style>
</head><body>
<div class="wrap">
  <div class="hero">
    <h1>My Lists – Admin</h1>
    <div class="subtitle">Last sync: ${lastSyncText}</div>
  </div>

  <div class="tabs">
    <button class="tab-btn active" data-tab="snap">📸 Snapshot</button>
    <button class="tab-btn" data-tab="add">➕ Add Lists</button>
    <button class="tab-btn" data-tab="custom">🎛 Customize Layout</button>
  </div>

  <!-- SNAPSHOT SECTION -->
  <div class="section active" id="sec-snap">
    <div class="card">
      <h3>Current Snapshot</h3>
      <ul>${rows}</ul>
      <div class="rowtools">
        <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}">
          <button class="btn2" type="submit">🔁 Sync Lists Now</button>
        </form>
        <form method="POST" action="/api/purge-sync?admin=${ADMIN_PASSWORD}" onsubmit="return confirm('Purge & re-sync everything?')">
          <button type="submit">🧹 Purge & Sync</button>
        </form>
        <span class="inline-note">Auto-sync every <b>${IMDB_SYNC_MINUTES}</b> min.</span>
      </div>
      <h4>Manifest URL</h4>
      <p class="code">${manifestUrl}</p>
      <div class="installRow">
        <button type="button" class="btn2" id="installBtn">⭐ Install to Stremio</button>
        <span class="mini muted">If the button doesn’t work, copy the manifest URL into Stremio manually.</span>
      </div>
      <p class="mini muted" style="margin-top:8px;">Manifest version automatically bumps when catalogs, sorting, or ordering change.</p>
    </div>
  </div>

  <!-- ADD LISTS SECTION -->
  <div class="section" id="sec-add">
    <div class="card">
      <h3>Add Sources (IMDb & Trakt)</h3>
      <p class="mini muted">Paste IMDb user /lists URLs, IMDb list URLs/ls-ids, or Trakt list URLs (user lists or <code>/lists/12345</code>, <code>/lists/official/slug</code>).</p>

      <div style="margin-top:8px">
        <div class="mini muted">Blocked lists (won't re-add on sync):</div>
        <div id="blockedPills"></div>
      </div>

      <p class="mini muted" style="margin-top:6px;">We merge your main IMDb user (+ extras) and explicit list URLs/IDs. Removing a list also blocks it so it won’t re-appear on the next sync.</p>

      <div class="row">
        <div><label class="mini">Add IMDb <b>User /lists</b> URL</label>
          <input id="userInput" placeholder="https://www.imdb.com/user/urXXXXXXX/lists/" />
        </div>
        <div><button id="addUser" type="button">Add</button></div>
      </div>
      <div class="row">
        <div><label class="mini">Add IMDb/Trakt <b>List</b> URL</label>
          <input id="listInput" placeholder="IMDb ls… or Trakt list URL" />
        </div>
        <div><button id="addList" type="button">Add</button></div>
      </div>

      <div style="margin-top:10px">
        <div class="mini muted">Your extra users:</div>
        <div id="userPills"></div>
      </div>
      <div style="margin-top:8px">
        <div class="mini muted">Your extra lists:</div>
        <div id="listPills"></div>
      </div>

      <h4 style="margin-top:14px">Discovered</h4>
      <ul>${disc}</ul>
    </div>
  </div>

  <!-- CUSTOMIZE SECTION -->
  <div class="section" id="sec-custom">
    <div class="card">
      <h3>Customize (enable, order, sort)</h3>
      <p class="muted">Drag rows to reorder lists, or use the ↑/↓ buttons. Click ▾ to open the drawer and tune sort options or custom order. Inside a list, you can drag tiles or move them with the little ↑/↓ controls.</p>
      <div id="prefs"></div>
    </div>
  </div>

</div>

<script>
const ADMIN="${ADMIN_PASSWORD}";
const SORT_OPTIONS = ${JSON.stringify(SORT_OPTIONS)};
const HOST_URL = ${JSON.stringify(base)};
const SECRET = ${JSON.stringify(SHARED_SECRET)};

async function getPrefs(){ const r = await fetch('/api/prefs?admin='+ADMIN); return r.json(); }
async function getLists(){ const r = await fetch('/api/lists?admin='+ADMIN); return r.json(); }
async function getListItems(lsid){ const r = await fetch('/api/list-items?admin='+ADMIN+'&lsid='+encodeURIComponent(lsid)); return r.json(); }
async function saveCustomOrder(lsid, order){
  const r = await fetch('/api/custom-order?admin='+ADMIN, {method:'POST',headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid, order })});
  if (!r.ok) throw new Error('save failed');
  return r.json();
}

// --- Install Button + Tabs Logic ---
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('installBtn');
  if (btn) {
    btn.onclick = (e) => {
      e.preventDefault();
      let url = HOST_URL.replace(/^https?:/, 'stremio:') + '/manifest.json';
      if (SECRET) url += '?key=' + SECRET;
      window.location.href = url;
    };
  }

  const tabs = document.querySelectorAll('.tab-btn');
  const sections = {
    snap: document.getElementById('sec-snap'),
    add: document.getElementById('sec-add'),
    custom: document.getElementById('sec-custom')
  };
  tabs.forEach(t => {
    t.addEventListener('click', () => {
      const target = t.getAttribute('data-tab');
      tabs.forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      Object.keys(sections).forEach(k => {
        sections[k].classList.toggle('active', k === target);
      });
    });
  });
});

function normalizeUserListsUrl(v){
  v = String(v||'').trim();
  if (!v) return null;
  if (/imdb\\.com\\/user\\/ur\\d+\\/lists/i.test(v)) return v;
  const m = v.match(/ur\\d{6,}/i);
  return m ? 'https://www.imdb.com/user/'+m[0]+'/lists/' : null;
}
function normalizeListIdO
