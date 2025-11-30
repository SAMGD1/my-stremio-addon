/*  My Lists – IMDb → Stremio (custom per-list ordering, IMDb date order, sources & UI)
 *  v12.4.1 – Trakt user-lists + global lists + IMDb chart/search pages + UI tabs + up/down reordering
 */
"use strict";

const express = require("express");
const fs = require("fs/promises");

// ----------------- ENV -----------------
const PORT  = Number(process.env.PORT || 10000);
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
 * listId is one of:
 *   - IMDb list:      "ls123456789"
 *   - IMDb chart/url: "imdburl:<encoded full URL>"
 *   - Trakt user list:"trakt:<user>:<slug>"
 *   - Trakt global:   "traktlist:<id-or-slug>"
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
  posterShape: {},        // kept for backwards-compat; not critical
  upgradeEpisodes: UPGRADE_EPISODES,
  sources: {              // extra sources you add in the UI
    users: [],            // array of IMDb / Trakt user /lists URLs
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

const isImdbListId   = v => /^ls\d{6,}$/i.test(String(v||""));
const isImdbUrlId    = v => /^imdburl:.+/i.test(String(v||""));
const isTraktUserListId   = v => /^trakt:[^:]+:[^:]+$/i.test(String(v||""));
const isTraktGlobalListId = v => /^traktlist:.+$/i.test(String(v||""));
const isTraktListId  = v => isTraktUserListId(v) || isTraktGlobalListId(v);
const isListId       = v => isImdbListId(v) || isImdbUrlId(v) || isTraktListId(v);

function makeTraktListKey(user, slug) {
  return "trakt:" + user + ":" + slug;
}
function makeTraktGlobalListKey(id) {
  return "traktlist:" + id;
}
function parseTraktListKey(id) {
  const m = String(id || "").match(/^trakt:([^:]+):(.+)$/i);
  return m ? { user: m[1], slug: m[2] } : null;
}
function parseTraktGlobalListKey(id) {
  const m = String(id || "").match(/^traktlist:(.+)$/i);
  return m ? { id: m[1] } : null;
}

const minutes = ms => Math.round(ms/60000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clampSortOptions = arr => (Array.isArray(arr) ? arr.filter(x => VALID_SORT.has(x)) : []);

async function fetchText(url) {
  const r = await fetch(url, { headers: REQ_HEADERS, redirect: "follow" });
  if (!r.ok) throw new Error("GET " + url + " -> " + r.status);
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
  const url = "https://api.github.com/repos/" + GITHUB_OWNER + "/" + GITHUB_REPO + path;
  const r = await fetch(url, {
    method,
    headers: {
      "Authorization": "Bearer " + GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": UA
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error("GitHub " + method + " " + path + " -> " + r.status + ": " + t);
  }
  return r.json();
}
async function ghGetSha(path) {
  try {
    const data = await gh("GET", "/contents/" + encodeURIComponent(path) + "?ref=" + encodeURIComponent(GITHUB_BRANCH));
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
  await gh("PUT", "/contents/" + encodeURIComponent(path), body);
}
async function loadSnapshot() {
  // try GitHub first
  if (GH_ENABLED) {
    try {
      const data = await gh("GET", "/contents/" + encodeURIComponent("data/snapshot.json") + "?ref=" + encodeURIComponent(GITHUB_BRANCH));
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
function parseTraktListUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/trakt\.tv\/users\/([^/]+)\/lists\/([^\/?#]+)/i);
  if (!m) return null;
  const user = decodeURIComponent(m[1]);
  const slug = decodeURIComponent(m[2]);
  return { user, slug };
}

// NEW: global / official lists like /lists/2435487 or /lists/official/john-wick-collection
function parseTraktGlobalListUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/trakt\.tv\/lists\/([^?#]+)/i);
  if (!m) return null;
  const id = decodeURIComponent(m[1].replace(/\/+$/,""));
  return { id };
}

async function traktJson(path) {
  if (!TRAKT_CLIENT_ID) throw new Error("TRAKT_CLIENT_ID not set");
  const url = "https://api.trakt.tv" + path;
  const r = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": TRAKT_CLIENT_ID,
      "User-Agent": UA
    },
    redirect: "follow"
  });
  if (!r.ok) throw new Error("Trakt " + path + " -> " + r.status);
  try { return await r.json(); } catch { return null; }
}

async function fetchTraktListMeta(user, slug) {
  try {
    const data = await traktJson("/users/" + encodeURIComponent(user) + "/lists/" + encodeURIComponent(slug));
    if (!data) return null;
    return {
      name: data.name || (user + "/" + slug),
      url: "https://trakt.tv/users/" + user + "/lists/" + slug
    };
  } catch (e) {
    console.warn("[TRAKT] list meta failed", user, slug, e.message);
    return null;
  }
}

// NEW: global lists meta
async function fetchTraktGlobalListMeta(id) {
  try {
    const data = await traktJson("/lists/" + encodeURIComponent(id));
    if (!data) return null;
    const name = data.name || id;
    return {
      name,
      url: "https://trakt.tv/lists/" + id
    };
  } catch (e) {
    console.warn("[TRAKT] global list meta failed", id, e.message);
    return null;
  }
}

async function fetchTraktListImdbIds(user, slug) {
  const types = [
    { key: "movies",   prop: "movie"   },
    { key: "shows",    prop: "show"    },
    { key: "episodes", prop: "episode" }
  ];
  const out = [];
  const seen = new Set();

  for (const obj of types) {
    let page = 1;
    while (true) {
      let items;
      try {
        items = await traktJson(
          "/users/" + encodeURIComponent(user) +
          "/lists/" + encodeURIComponent(slug) +
          "/items/" + obj.key + "?page=" + page + "&limit=100"
        );
      } catch (e) {
        console.warn("[TRAKT] items fetch failed", user, slug, obj.key, e.message);
        break;
      }
      if (!Array.isArray(items) || !items.length) break;

      for (const it of items) {
        const entity = it[obj.prop];
        const ids = entity && entity.ids;
        let imdb = ids && ids.imdb;

        if (!imdb && obj.key === "episodes" && it.show && it.show.ids && it.show.ids.imdb) {
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

// NEW: global lists items
async function fetchTraktGlobalListImdbIds(id) {
  const types = [
    { key: "movies",   prop: "movie"   },
    { key: "shows",    prop: "show"    },
    { key: "episodes", prop: "episode" }
  ];
  const out = [];
  const seen = new Set();

  for (const obj of types) {
    let page = 1;
    while (true) {
      let items;
      try {
        items = await traktJson(
          "/lists/" + encodeURIComponent(id) +
          "/items/" + obj.key + "?page=" + page + "&limit=100"
        );
      } catch (e) {
        console.warn("[TRAKT] global items fetch failed", id, obj.key, e.message);
        break;
      }
      if (!Array.isArray(items) || !items.length) break;

      for (const it of items) {
        const entity = it[obj.prop];
        const ids = entity && entity.ids;
        let imdb = ids && ids.imdb;

        if (!imdb && obj.key === "episodes" && it.show && it.show.ids && it.show.ids.imdb) {
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

// NEW: discover all public lists from a Trakt user /lists page
async function discoverTraktUserLists(userListsUrl) {
  if (!TRAKT_CLIENT_ID) {
    console.warn("[TRAKT] discoverTraktUserLists called without TRAKT_CLIENT_ID");
    return [];
  }
  if (!userListsUrl) return [];
  const m = String(userListsUrl).match(/trakt\.tv\/users\/([^/]+)\/lists/i);
  if (!m) return [];
  const user = decodeURIComponent(m[1]);

  let arr;
  try {
    arr = await traktJson("/users/" + encodeURIComponent(user) + "/lists");
  } catch (e) {
    console.warn("[TRAKT] discoverTraktUserLists failed", user, e.message);
    return [];
  }
  if (!Array.isArray(arr)) return [];

  return arr.map(l => {
    const slug = (l.ids && l.ids.slug) || l.slug || String((l.ids && l.ids.trakt) || "");
    const id   = makeTraktListKey(user, slug || ("list-" + Date.now()));
    return {
      id,
      url: "https://trakt.tv/users/" + user + "/lists/" + slug,
      name: l.name || (user + "/" + slug)
    };
  });
}

// ----------------- IMDb DISCOVERY -----------------
function normalizeListIdOrUrl(s) {
  if (!s) return null;
  s = String(s).trim();

  // classic IMDb list id
  const m = s.match(/ls\d{6,}/i);
  if (m) return { id: m[0], url: "https://www.imdb.com/list/" + m[0] + "/" };

  // explicit list URL
  if (/imdb\.com\/list\//i.test(s)) return { id: null, url: s };

  // NEW: treat chart/search pages as "lists"
  if (/imdb\.com\/(chart|search)\//i.test(s)) {
    const url = s.startsWith("http") ? s : ("https://www.imdb.com" + s);
    const enc = encodeURIComponent(url);
    return { id: "imdburl:" + enc, url };
  }

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
  const arr = Array.from(ids).map(id => ({ id, url: "https://www.imdb.com/list/" + id + "/" }));
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
function nextPageUrl(html) {
  let m = html.match(/<a[^>]+rel=["']next["'][^>]+href=["']([^"']+)["']/i);
  if (!m) m = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*lister-page-next[^"']*["']/i);
  if (!m) m = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*data-testid=["']pagination-next-page-button["'][^>]*>/i);
  if (!m) return null;
  try { return new URL(m[1], "https://www.imdb.com").toString(); } catch { return null; }
}
async function fetchImdbListIdsAllPages(listUrl, maxPages = 80) {
  // raw order (whatever the list currently displays by default)
  const seen = new Set(); const ids = [];
  let url = withParam(listUrl, "mode", "detail");
  let pages = 0;
  while (url && pages < maxPages) {
    let html; try { html = await fetchText(withParam(url, "_", Date.now())); } catch { break; }
    const found = tconstsFromHtml(html);
    let added = 0;
    for (const tt of found) if (!seen.has(tt)) { seen.add(tt); ids.push(tt); added++; }
    pages++;
    const next = nextPageUrl(html);
    if (!next || !added) break;
    url = next;
    await sleep(80);
  }
  return ids;
}
// fetch order IMDb shows when sorted a certain way
async function fetchImdbOrder(listUrl, sortSpec /* e.g. "release_date,asc" */, maxPages = 80) {
  const seen = new Set(); const ids = [];
  let url = withParam(withParam(listUrl, "mode", "detail"), "sort", sortSpec);
  let pages = 0;
  while (url && pages < maxPages) {
    let html; try { html = await fetchText(withParam(url, "_", Date.now())); } catch { break; }
    const found = tconstsFromHtml(html);
    for (const tt of found) if (!seen.has(tt)) { seen.add(tt); ids.push(tt); }
    pages++;
    const next = nextPageUrl(html);
    if (!next) break;
    url = next;
    await sleep(80);
  }
  return ids;
}

// ----------------- METADATA -----------------
async function fetchCinemeta(kind, imdbId) {
  try {
    const j = await fetchJson(CINEMETA + "/meta/" + kind + "/" + imdbId + ".json");
    return j && j.meta ? j.meta : null;
  } catch { return null; }
}
async function imdbJsonLd(imdbId) {
  try {
    const html = await fetchText("https://www.imdb.com/title/" + imdbId + "/");
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
      ? ld["@graph"].find(x => (x["@id"] || "").includes("/title/" + imdbId)) || ld["@graph"][0]
      : ld;
    name = node && (node.name || node.headline || ld && ld.name);
    poster = node && (typeof node.image === "string" ? node.image : (node.image && node.image.url)) || (ld && ld.image);
    background = poster;
    released = node && (node.datePublished || node.startDate || node.releaseDate) || undefined;
    year = released ? Number(String(released).slice(0,4)) : undefined;
    const t = node && node["@type"];
    const ts = Array.isArray(t) ? t.join(",") : (t || "");
    if (/Series/i.test(ts)) type = "series";
    else if (/TVEpisode/i.test(ts)) type = "episode";
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

  const portrait = m.poster || fb.poster;
  const landscape = m.background || m.backdrop || portrait || fb.poster;

  return {
    id: imdbId,
    type: rec.kind || fb.type || "movie",
    name: m.name || fb.name || imdbId,
    poster: portrait || landscape || undefined,
    posterPortrait: portrait || landscape || undefined,
    posterLandscape: landscape || portrait || undefined,
    background: m.background || m.backdrop || undefined,
    imdbRating: m.imdbRating ?? undefined,
    runtime: m.runtime ?? undefined,
    year: m.year ?? fb.year ?? undefined,
    releaseDate: m.released || m.releaseInfo || fb.releaseDate || undefined,
    description: m.description || undefined
  };
}

function toTs(d,y){ if(d){const t=Date.parse(d); if(!Number.isNaN(t)) return t;} if(y){const t=Date.parse(String(y)+"-01-01"); if(!Number.isNaN(t)) return t;} return null; }
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
  const shapes  = JSON.stringify(PREFS.posterShape || {});
  const order   = (PREFS.order || []).join(",");

  return enabled.join(",") + "#" + order + "#" + PREFS.defaultList + "#" + names + "#" + perSort + "#" + perOpts + "#c" + custom + "#sh" + shapes;
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

  // 2) extra IMDb / Trakt user /lists URLs from prefs
  const users = Array.from(
    new Set((PREFS.sources?.users || []).map(s => String(s).trim()).filter(Boolean))
  );
  for (const u of users) {
    try {
      if (/trakt\.tv/i.test(u)) {
        const arr = await discoverTraktUserLists(u);
        arr.forEach(add);
      } else {
        const arr = await discoverFromUserLists(u);
        arr.forEach(add);
      }
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

    // Trakt user lists
    const tinfo = parseTraktListUrl(val);
    if (tinfo) {
      if (!TRAKT_CLIENT_ID) {
        console.warn("[TRAKT] got user list", val, "but TRAKT_CLIENT_ID is not set – ignoring.");
      } else {
        const key = makeTraktListKey(tinfo.user, tinfo.slug);
        if (!blocked.has(key)) {
          let name = key;
          try {
            const meta = await fetchTraktListMeta(tinfo.user, tinfo.slug);
            if (meta) name = meta.name || name;
          } catch (e) {
            console.warn("[TRAKT] meta fetch failed for", val, e.message);
          }
          add({
            id: key,
            url: "https://trakt.tv/users/" + tinfo.user + "/lists/" + tinfo.slug,
            name
          });
        }
      }
      await sleep(60);
      continue;
    }

    // Trakt global lists
    const ginfo = parseTraktGlobalListUrl(val);
    if (ginfo) {
      if (!TRAKT_CLIENT_ID) {
        console.warn("[TRAKT] got global list", val, "but TRAKT_CLIENT_ID is not set – ignoring.");
      } else {
        const key = makeTraktGlobalListKey(ginfo.id);
        if (!blocked.has(key)) {
          let name = ginfo.id;
          try {
            const meta = await fetchTraktGlobalListMeta(ginfo.id);
            if (meta && meta.name) name = meta.name;
          } catch (e) {
            console.warn("[TRAKT] global meta fetch failed for", val, e.message);
          }
          add({
            id: key,
            url: "https://trakt.tv/lists/" + ginfo.id,
            name
          });
        }
      }
      await sleep(60);
      continue;
    }

    // IMDb lists / charts / searches
    const norm = normalizeListIdOrUrl(val);
    if (!norm) continue;
    let id = norm.id;
    let url = norm.url;
    if (!id) {
      const m = String(url).match(/ls\d{6,}/i);
      if (m) id = m[0];
    }
    if (!id) continue;

    let name = id;
    try { name = await fetchListName(url); } catch {}

    add({ id, url, name });
    await sleep(60);
  }

  return Array.from(map.values());
}

async function fullSync(opts) {
  const rediscover = !opts || opts.rediscover !== false;
  if (syncInProgress) return;
  syncInProgress = true;
  const started = Date.now();
  try {
    let discovered = [];
    if (rediscover) {
      discovered = await harvestSources();
    }
    if ((!discovered || !discovered.length) && IMDB_LIST_IDS.length) {
      discovered = IMDB_LIST_IDS.map(id => ({ id, name: id, url: "https://www.imdb.com/list/" + id + "/" }));
      console.log("[DISCOVER] used IMDB_LIST_IDS fallback (" + discovered.length + ")");
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

    const uniques = new Set();
    for (const id of Object.keys(next)) {
      const list = next[id];
      let raw = [];

      if (isTraktListId(id)) {
        if (!TRAKT_CLIENT_ID) {
          console.warn("[SYNC] Trakt list present but TRAKT_CLIENT_ID missing", id);
        } else if (isTraktUserListId(id)) {
          const ts = parseTraktListKey(id);
          if (ts) {
            try { raw = await fetchTraktListImdbIds(ts.user, ts.slug); }
            catch (e) { console.warn("[SYNC] Trakt user list fetch failed for", id, e.message); }
          }
        } else if (isTraktGlobalListId(id)) {
          const gl = parseTraktGlobalListKey(id);
          if (gl) {
            try { raw = await fetchTraktGlobalListImdbIds(gl.id); }
            catch (e) { console.warn("[SYNC] Trakt global list fetch failed for", id, e.message); }
          }
        }
      } else {
        const url = list.url || (isImdbUrlId(id) ? decodeURIComponent(id.slice("imdburl:".length)) : ("https://www.imdb.com/list/" + id + "/"));
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

    const totalItems = Object.values(LISTS).reduce((n,L)=>n+(L.ids?.length||0),0);
    console.log("[SYNC] ok – " + totalItems + " items across " + Object.keys(LISTS).length + " lists in " + minutes(Date.now()-started) + " min");
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
  const u = new URL(req.originalUrl, "http://" + req.headers.host);
  return u.searchParams.get("key") === SHARED_SECRET;
}
function adminAllowed(req){
  const u = new URL(req.originalUrl, "http://" + req.headers.host);
  return (u.searchParams.get("admin") || req.headers["x-admin-key"]) === ADMIN_PASSWORD;
}
const absoluteBase = req => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return proto + "://" + host;
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
    .sort((a,b)=>((LISTS[a]?.name||a).localeCompare(LISTS[b]?.name||b)));
  const ordered = base.concat(missing);
  return ordered.filter(id => enabled.has(id));
}
function catalogs(){
  const ids = getEnabledOrderedIds();
  return ids.map(lsid => ({
    type: "my lists",
    id: "list:" + lsid,
    name: "🗂 " + (LISTS[lsid]?.name || lsid),
    extraSupported: ["search","skip","limit","sort"],
    extra: [
      { name:"search" }, { name:"skip" }, { name:"limit" },
      { name:"sort", options: (PREFS.sortOptions && PREFS.sortOptions[lsid] && PREFS.sortOptions[lsid].length)
          ? PREFS.sortOptions[lsid] : SORT_OPTIONS }
    ],
    posterShape: (PREFS.posterShape && PREFS.posterShape[lsid]) || "poster"
  }));
}
app.get("/manifest.json", (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();
    const version = baseManifest.version + "-" + MANIFEST_REV;
    res.json({
      ...baseManifest,
      version,
      catalogs: catalogs(),
      configuration: absoluteBase(req) + "/configure"
    });
  }catch(e){ console.error("manifest:", e); res.status(500).send("Internal Server Error");}
});

app.get("/configure", (req, res) => {
  const base = absoluteBase(req);
  const dest = base + "/admin?admin=" + encodeURIComponent(ADMIN_PASSWORD);

  res.type("html").send(
"<!doctype html><meta charset=\"utf-8\">" +
"<title>Configure – My Lists</title>" +
"<meta http-equiv=\"refresh\" content=\"0; url='" + dest + "'\">" +
"<style>body{font-family:system-ui;background:#0f0d1a;color:#f7f7fb;display:grid;place-items:center;height:100vh;margin:0}a{color:#9aa0b4;}</style>" +
"<p>Opening admin… <a href=\"" + dest + "\">continue</a></p>"
  );
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

    const id = req.params.id;
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

    const shape = (PREFS.posterShape && PREFS.posterShape[lsid]) || "poster";
    metas = metas.map(m => {
      const rec = BEST.get(m.id);
      const bg = rec && rec.meta && (rec.meta.background || rec.meta.backdrop);
      const portrait = m.posterPortrait || m.poster || m.posterLandscape || bg;
      const landscape = m.posterLandscape || bg || m.poster || m.posterPortrait;
      if (shape === "landscape") {
        return { ...m, poster: landscape || portrait };
      } else {
        return { ...m, poster: portrait || landscape };
      }
    });

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
    res.json({ meta: { ...m, id: imdbId, type: rec.kind } });
  }catch(e){ console.error("meta:", e); res.status(500).send("Internal Server Error"); }
});

// ------- Admin JSON / actions -------
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

    PREFS.posterShape = body.posterShape && typeof body.posterShape === "object"
      ? Object.fromEntries(
          Object.entries(body.posterShape)
            .filter(([k,v]) => isListId(k) && (v === "poster" || v === "landscape"))
        )
      : (PREFS.posterShape || {});

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

  const items = ids.map(tt => {
    let c = CARD.get(tt) || cardFor(tt);
    if (!c.posterPortrait || !c.posterLandscape) {
      const rec = BEST.get(tt);
      const bg = rec && rec.meta && (rec.meta.background || rec.meta.backdrop);
      const portrait = c.posterPortrait || c.poster || c.posterLandscape || bg;
      const landscape = c.posterLandscape || bg || c.poster || c.posterPortrait;
      c = { ...c, posterPortrait: portrait || landscape, posterLandscape: landscape || portrait };
      CARD.set(tt, c);
    }
    return c;
  });

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

    LAST_MANIFEST_KEY = ""; MANIFEST_REV++;
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
    res.status(200).send("Synced at " + new Date().toISOString() + ". <a href=\"/admin?admin=" + ADMIN_PASSWORD + "\">Back</a>");
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
    res.status(200).send("Purged & synced at " + new Date().toISOString() + ". <a href=\"/admin?admin=" + ADMIN_PASSWORD + "\">Back</a>");
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

// ------- Admin page (tabs + up/down buttons) -------
app.get("/admin", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  const base = absoluteBase(req);
  const manifestUrl = base + "/manifest.json" + (SHARED_SECRET ? "?key=" + SHARED_SECRET : "");

  let discovered = [];
  try { discovered = await harvestSources(); } catch {}

  const rows = Object.keys(LISTS).map(id => {
    const L = LISTS[id]; const count=(L.ids||[]).length;
    return "<li><b>" + (L.name||id) + "</b> <small>(" + count + " items)</small><br/><small>" + (L.url||"") + "</small></li>";
  }).join("") || "<li>(none)</li>";

  const disc = discovered.map(d=>"<li><b>" + (d.name||d.id) + "</b><br/><small>" + d.url + "</small></li>").join("") || "<li>(none)</li>";

  const lastSyncText = LAST_SYNC_AT
    ? (new Date(LAST_SYNC_AT).toLocaleString() + " (" + Math.round((Date.now()-LAST_SYNC_AT)/60000) + " min ago)")
    : "never";

  res.type("html").send(
"<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />" +
"<title>My Lists – Admin</title>" +
"<style>" +
":root{color-scheme:light;--bg:#050415;--bg2:#0f0d1a;--card:#141129;--muted:#9aa0b4;--text:#f7f7fb;--accent:#6c5ce7;--accent2:#8b7cf7;--accent-soft:rgba(108,92,231,.18);--border:#262145;--danger:#ff7675;}" +
"body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:0;background:radial-gradient(circle at top,#2f2165 0,#050415 48%,#02010a 100%);color:var(--text);}" +
".wrap{max-width:1100px;margin:24px auto;padding:0 16px}" +
".hero{padding:20px 0 8px}" +
"h1{margin:0 0 4px;font-weight:700;font-size:26px;letter-spacing:.01em}" +
".subtitle{color:var(--muted);font-size:14px}" +
".navtabs{margin:8px 0 16px;display:flex;flex-wrap:wrap;gap:8px}" +
".navtab{padding:6px 14px;border-radius:999px;border:1px solid var(--border);background:rgba(10,8,30,.9);color:var(--muted);cursor:pointer;font-size:13px}" +
".navtab.active{background:var(--accent);color:#fff;border-color:var(--accent2)}" +
".grid{display:grid;gap:16px;grid-template-columns:1fr}" +
".card{border:1px solid var(--border);border-radius:18px;padding:16px 18px;background:linear-gradient(145deg,rgba(17,14,39,.96),rgba(8,6,25,.98));box-shadow:0 18px 40px rgba(0,0,0,.55);margin-bottom:16px}" +
"h3{margin:0 0 8px;font-size:17px}" +
"h4{margin:10px 0 4px;font-size:14px}" +
"button{padding:9px 14px;border:0;border-radius:999px;background:var(--accent);color:#fff;cursor:pointer;font-size:13px;display:inline-flex;align-items:center;gap:6px;box-shadow:0 6px 16px rgba(108,92,231,.55)}" +
"button.btn2{background:var(--accent2)}" +
"button:disabled{opacity:.5;cursor:default;box-shadow:none}" +
"small{color:var(--muted)}" +
".code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#1c1837;color:#d6d3ff;padding:4px 6px;border-radius:6px;font-size:12px;word-break:break-all}" +
"table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}" +
"th,td{padding:8px 6px;border-bottom:1px solid rgba(38,33,69,.8);text-align:left;vertical-align:top}" +
"th{font-weight:600;color:#d7d1ff;font-size:12px}" +
"tr:hover td{background:rgba(17,14,40,.7);}" +
".muted{color:var(--muted)}" +
".chev{cursor:pointer;font-size:16px;line-height:1;user-select:none}" +
".drawer{background:#120f25}" +
".thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin:12px 0;padding:0;list-style:none}" +
".thumb{position:relative;display:flex;gap:10px;align-items:center;border:1px solid var(--border);background:#1a1636;border-radius:12px;padding:6px 8px}" +
".thumb-img{object-fit:cover;border-radius:6px;background:#2a244e;flex-shrink:0}" +
".thumbs.shape-poster .thumb-img{width:52px;height:78px}" +
".thumbs.shape-landscape .thumb-img{width:86px;height:52px}" +
".thumb .title{font-size:14px}.thumb .id{font-size:11px;color:var(--muted)}" +
".thumb[draggable=\"true\"]{cursor:grab}.thumb.dragging{opacity:.5}" +
".thumb .del{position:absolute;top:6px;right:6px;width:20px;height:20px;line-height:20px;text-align:center;border-radius:999px;background:#3a2c2c;color:#ffb4b4;font-weight:700;display:none}" +
".thumb:hover .del{display:block}" +
".thumb.add{align-items:center;justify-content:center;border:1px dashed var(--border);min-height:90px}" +
".addbox{width:100%;text-align:center}" +
".addbox input{margin-top:6px;width:100%;box-sizing:border-box;background:#1c1837;color:#f7f7fb;border:1px solid var(--border);border-radius:8px;padding:8px}" +
".rowtools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;margin-top:4px}" +
".inline-note{font-size:12px;color:var(--muted);margin-left:8px}" +
".pill{display:inline-flex;align-items:center;gap:8px;background:#1c1837;border:1px solid var(--border);border-radius:999px;padding:4px 9px;color:#dcd8ff;font-size:12px;margin:2px 4px 2px 0}" +
".pill input{margin-right:4px}.pill .x{cursor:pointer;color:#ffb4b4;font-size:11px}" +
"input[type=\"text\"]{background:#1c1837;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 9px;width:100%;font-size:13px}" +
".row{display:grid;gap:10px;grid-template-columns:1fr 110px;margin-bottom:8px}" +
".mini{font-size:12px}" +
"a.link{color:#b1b9ff;text-decoration:none}a.link:hover{text-decoration:underline}" +
".installRow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}" +
".movebtn{background:#1c1837;box-shadow:none;padding:4px 7px;font-size:11px;margin:0 2px}" +
"body.view-snapshot .card.snapshot{display:block}" +
"body.view-snapshot .card.sources,body.view-snapshot .card.customize{display:none}" +
"body.view-sources .card.sources{display:block}" +
"body.view-sources .card.snapshot,body.view-sources .card.customize{display:none}" +
"body.view-custom .card.customize{display:block}" +
"body.view-custom .card.snapshot,body.view-custom .card.sources{display:none}" +
"</style></head><body class=\"view-snapshot\">" +
"<div class=\"wrap\">" +
"<div class=\"hero\">" +
"<h1>My Lists – Admin</h1>" +
"<div class=\"subtitle\">Last sync: " + lastSyncText + "</div>" +
"<div class=\"navtabs\">" +
"<button type=\"button\" class=\"navtab active\" data-view=\"snapshot\">Snapshot</button>" +
"<button type=\"button\" class=\"navtab\" data-view=\"sources\">Add lists</button>" +
"<button type=\"button\" class=\"navtab\" data-view=\"custom\">Customize layout</button>" +
"</div></div>" +
"<div class=\"grid\">" +
"<div class=\"card snapshot\">" +
"<h3>Current Snapshot</h3>" +
"<ul>" + rows + "</ul>" +
"<div class=\"rowtools\">" +
"<form method=\"POST\" action=\"/api/sync?admin=" + ADMIN_PASSWORD + "\"><button class=\"btn2\" type=\"submit\">🔁 Sync Lists Now</button></form>" +
"<form method=\"POST\" action=\"/api/purge-sync?admin=" + ADMIN_PASSWORD + "\" onsubmit=\"return confirm('Purge & re-sync everything?')\"><button type=\"submit\">🧹 Purge & Sync</button></form>" +
"<span class=\"inline-note\">Auto-sync every <b>" + IMDB_SYNC_MINUTES + "</b> min.</span>" +
"</div>" +
"<h4>Manifest URL</h4>" +
"<p class=\"code\">" + manifestUrl + "</p>" +
"<div class=\"installRow\">" +
"<button type=\"button\" class=\"btn2\" id=\"installBtn\">⭐ Install to Stremio</button>" +
"<span class=\"mini muted\">If the button doesn’t work, copy the manifest URL into Stremio manually.</span>" +
"</div>" +
"<p class=\"mini muted\" style=\"margin-top:8px;\">Manifest version automatically bumps when catalogs, sorting, poster shapes or ordering change.</p>" +
"</div>" +
"<div class=\"card sources\">" +
"<h3>Discovered & Sources</h3>" +
"<div style=\"margin-top:8px\"><div class=\"mini muted\">Blocked lists (won't re-add on sync):</div><div id=\"blockedPills\"></div></div>" +
"<p class=\"mini muted\" style=\"margin-top:6px;\">We merge your main user (+ extras) and explicit list URLs/IDs. Removing a list also blocks it so it won’t re-appear on the next sync.</p>" +
"<div class=\"row\"><div><label class=\"mini\">Add IMDb/Trakt <b>User lists</b> URL</label><input id=\"userInput\" placeholder=\"IMDb or Trakt user /lists page\" /></div><div><button id=\"addUser\" type=\"button\">Add</button></div></div>" +
"<div class=\"row\"><div><label class=\"mini\">Add IMDb/Trakt <b>List</b> URL</label><input id=\"listInput\" placeholder=\"IMDb ls… or chart/search, or Trakt list URL\" /></div><div><button id=\"addList\" type=\"button\">Add</button></div></div>" +
"<div style=\"margin-top:10px\"><div class=\"mini muted\">Your extra users:</div><div id=\"userPills\"></div></div>" +
"<div style=\"margin-top:8px\"><div class=\"mini muted\">Your extra lists:</div><div id=\"listPills\"></div></div>" +
"<h4 style=\"margin-top:14px\">Discovered</h4><ul>" + disc + "</ul>" +
"</div></div>" +
"<div class=\"card customize\">" +
"<h3>Customize (enable, order, sort)</h3>" +
"<p class=\"muted\">Drag rows to reorder lists, or use the ↑ / ↓ buttons if you don’t have a mouse. Click ▾ to open the drawer and tune sort options or custom order.</p>" +
"<div id=\"prefs\"></div>" +
"</div></div>" +
"<script>" +
"const ADMIN='" + ADMIN_PASSWORD + "';" +
"const SORT_OPTIONS=" + JSON.stringify(SORT_OPTIONS) + ";" +
"const HOST_URL=" + JSON.stringify(base) + ";" +
"const SECRET=" + JSON.stringify(SHARED_SECRET) + ";" +
"const BOOT_PREFS=" + JSON.stringify(PREFS) + ";" +
"const BOOT_LISTS=" + JSON.stringify(LISTS) + ";" +

"function setView(view){document.body.classList.remove('view-snapshot','view-sources','view-custom');document.body.classList.add('view-'+view);document.querySelectorAll('.navtab').forEach(function(btn){btn.classList.toggle('active',btn.getAttribute('data-view')===view);});}" +

"function normalizeUserListsUrl(v){v=String(v||'').trim();if(!v)return null;if(/trakt\\.tv\\/users\\/[^/]+\\/lists/i.test(v))return v;if(/trakt\\.tv\\/users\\/[^/]+\\/?$/i.test(v))return v.replace(/\\/?$/,'/lists');if(/imdb\\.com\\/user\\/ur\\d+\\/lists/i.test(v))return v;var m=v.match(/ur\\d{6,}/i);if(m)return 'https://www.imdb.com/user/'+m[0]+'/lists/';return null;}" +
"function normalizeListIdOrUrl2(v){v=String(v||'').trim();if(!v)return null;if(/trakt\\.tv\\/users\\/[^/]+\\/lists\\/[^/?#]+/i.test(v))return v;if(/trakt\\.tv\\/lists\\//i.test(v))return v;if(/imdb\\.com\\/list\\//i.test(v))return v;if(/imdb\\.com\\/(chart|search)\\//i.test(v))return v;var m=v.match(/ls\\d{6,}/i);if(m)return 'https://www.imdb.com/list/'+m[0]+'/';return null;}" +
"function el(tag,attrs,kids){var e=document.createElement(tag);attrs=attrs||{};kids=kids||[];for(var k in attrs){if(k==='text')e.textContent=attrs[k];else if(k==='html')e.innerHTML=attrs[k];else e.setAttribute(k,attrs[k]);}kids.forEach(function(ch){e.appendChild(ch);});return e;}" +
"function isCtrl(node){var t=(node&&node.tagName||'').toLowerCase();return t==='input'||t==='select'||t==='button'||t==='a'||t==='label'||t==='textarea';}" +

"function attachRowDnD(tbody){var dragSrc=null;tbody.addEventListener('dragstart',function(e){var tr=e.target.closest('tr[data-lsid]');if(!tr||isCtrl(e.target))return;dragSrc=tr;tr.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',tr.getAttribute('data-lsid')||'');});tbody.addEventListener('dragend',function(){if(dragSrc)dragSrc.classList.remove('dragging');dragSrc=null;});tbody.addEventListener('dragover',function(e){e.preventDefault();if(!dragSrc)return;var over=e.target.closest('tr[data-lsid]');if(!over||over===dragSrc)return;var rect=over.getBoundingClientRect();var before=(e.clientY-rect.top)<rect.height/2;over.parentNode.insertBefore(dragSrc,before?over:over.nextSibling);});}" +

"function attachThumbDnD(ul){var src=null;ul.addEventListener('dragstart',function(e){var li=e.target.closest('li.thumb');if(!li||li.hasAttribute('data-add'))return;src=li;li.classList.add('dragging');e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',li.getAttribute('data-id')||'');});ul.addEventListener('dragend',function(){if(src){src.classList.remove('dragging');src=null;}});ul.addEventListener('dragover',function(e){e.preventDefault();if(!src)return;var over=e.target.closest('li.thumb');if(!over||over===src||over.hasAttribute('data-add'))return;var rect=over.getBoundingClientRect();var before=(e.clientY-rect.top)<rect.height/2;over.parentNode.insertBefore(src,before?over:over.nextSibling);});}" +

"function toTsC(d,y){if(d){var t=Date.parse(d);if(!Number.isNaN(t))return t;}if(y){var t2=Date.parse(String(y)+'-01-01');if(!Number.isNaN(t2))return t2;}return null;}" +
"function stableSortClient(items,sortKey){var s=String(sortKey||'name_asc').toLowerCase();var dir=s.endsWith('_asc')?1:-1;var key=s.split('_')[0];function cmpNull(a,b){if(a==null&&b==null)return 0; if(a==null)return 1; if(b==null)return -1; return a<b?-1:(a>b?1:0);}return items.map(function(m,i){return{m:m,i:i};}).sort(function(A,B){var a=A.m,b=B.m,c=0;if(key==='date')c=cmpNull(toTsC(a.releaseDate,a.year),toTsC(b.releaseDate,b.year));else if(key==='rating')c=cmpNull(a.imdbRating==null?null:a.imdbRating,b.imdbRating==null?null:b.imdbRating);else if(key==='runtime')c=cmpNull(a.runtime==null?null:a.runtime,b.runtime==null?null:b.runtime);else c=(a.name||'').localeCompare(b.name||'');if(c===0){c=(a.name||'').localeCompare(b.name||'');if(c===0)c=(a.id||'').localeCompare(b.id||'');if(c===0)c=A.i-B.i;}return c*dir;}).map(function(x){return x.m;});}" +

"function renderPills(id,arr,onRemove){var wrap=document.getElementById(id);wrap.innerHTML='';if(!arr||!arr.length){wrap.textContent='(none)';return;}arr.forEach(function(txt,idx){var pill=el('span',{class:'pill'},[el('span',{text:txt}),el('span',{class:'x',text:'✕'})]);pill.querySelector('.x').onclick=function(){onRemove(idx);};wrap.appendChild(pill);wrap.appendChild(document.createTextNode(' '));});}" +

"async function addSources(payload){await fetch('/api/add-sources?admin='+ADMIN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});location.reload();}" +

"async function unblockId(lsid){await fetch('/api/unblock-list?admin='+ADMIN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lsid:lsid})});location.reload();}" +

"function buildAddTab(){var prefs=BOOT_PREFS;renderPills('userPills',(prefs.sources&&prefs.sources.users)||[],function(i){prefs.sources.users.splice(i,1);savePrefs();});renderPills('listPills',(prefs.sources&&prefs.sources.lists)||[],function(i){prefs.sources.lists.splice(i,1);savePrefs();});var blockedWrap=document.getElementById('blockedPills');blockedWrap.innerHTML='';var blocked=prefs.blocked||[];if(!blocked.length)blockedWrap.textContent='(none)';blocked.forEach(function(lsid){var pill=el('span',{class:'pill'},[el('span',{text:lsid}),el('span',{class:'x',text:'Unblock'})]);pill.querySelector('.x').onclick=function(){unblockId(lsid);};blockedWrap.appendChild(pill);blockedWrap.appendChild(document.createTextNode(' '));});}" +

"function buildCustomize(){var prefs=BOOT_PREFS;var lists=BOOT_LISTS;prefs.posterShape=prefs.posterShape||{};var container=document.getElementById('prefs');container.innerHTML='';var enabledSet=new Set(prefs.enabled&&prefs.enabled.length?prefs.enabled:Object.keys(lists));var baseOrder=prefs.order&&prefs.order.length?prefs.order.filter(function(id){return lists[id];}):[];var missing=Object.keys(lists).filter(function(id){return baseOrder.indexOf(id)===-1;}).sort(function(a,b){return (lists[a].name||a).localeCompare(lists[b].name||b);});var order=baseOrder.concat(missing);var table=el('table');var thead=el('thead',{},[el('tr',{},[el('th',{text:''}),el('th',{text:'Enabled'}),el('th',{text:'List (id)'}),el('th',{text:'Items'}),el('th',{text:'Default sort'}),el('th',{text:'Move'}),el('th',{text:'Remove'})])]);table.appendChild(thead);var tbody=el('tbody');order.forEach(function(lsid){var L=lists[lsid];if(!L)return;var tr=el('tr',{'data-lsid':lsid});tr.setAttribute('draggable','true');var tdChev=el('td');var chev=el('span',{class:'chev',text:'▾'});tdChev.appendChild(chev);tr.appendChild(tdChev);var tdEn=el('td');var cb=en=document.createElement('input');cb.type='checkbox';cb.checked=enabledSet.has(lsid);cb.onchange=function(){if(cb.checked)enabledSet.add(lsid);else enabledSet.delete(lsid);};tdEn.appendChild(cb);tr.appendChild(tdEn);var infoTd=el('td');var html='<div>'+ (L.name||lsid) +'</div><div class=\"mini muted\">'+lsid+'</div>';if(L.url){html+='<div class=\"mini\"><a class=\"link\" href=\"'+L.url+'\" target=\"_blank\" rel=\"noopener\">open</a></div>';}infoTd.innerHTML=html;tr.appendChild(infoTd);var tdCount=el('td',{text:String((L.ids||[]).length)});tr.appendChild(tdCount);var tdSort=el('td');var sel=document.createElement('select');SORT_OPTIONS.forEach(function(opt){var o=document.createElement('option');o.value=opt;o.textContent=opt;if((prefs.perListSort&&prefs.perListSort[lsid])===opt)o.selected=true;tdSort.appendChild(sel);});sel.onchange=function(){prefs.perListSort=prefs.perListSort||{};prefs.perListSort[lsid]=sel.value;};tdSort.appendChild(sel);tr.appendChild(tdSort);var tdMove=el('td');var upBtn=el('button',{class:'movebtn',text:'↑'});var dnBtn=el('button',{class:'movebtn',text:'↓'});upBtn.onclick=function(e){e.preventDefault();var prev=tr.previousElementSibling;if(prev&&prev.hasAttribute('data-lsid'))tbody.insertBefore(tr,prev);};dnBtn.onclick=function(e){e.preventDefault();var next=tr.nextElementSibling;if(next&&next.hasAttribute('data-lsid'))tbody.insertBefore(next.nextSibling?next.nextSibling:next,tr);};tdMove.appendChild(upBtn);tdMove.appendChild(dnBtn);tr.appendChild(tdMove);var tdRem=el('td');var remBtn=el('button',{text:'Remove'});remBtn.onclick=function(e){e.preventDefault();if(!confirm('Remove this list and block it from re-sync?'))return;fetch('/api/remove-list?admin='+ADMIN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lsid:lsid})}).then(function(){location.reload();});};tdRem.appendChild(remBtn);tr.appendChild(tdRem);tbody.appendChild(tr);chev.onclick=function(){var existing=document.querySelector('tr.drawer[data-for=\"'+lsid+'\"]');if(existing){existing.parentNode.removeChild(existing);chev.textContent='▾';return;}chev.textContent='▴';var dr=el('tr',{class:'drawer','data-for':lsid});var td=el('td',{colspan:'7'});td.appendChild(el('div',{text:'Loading…'}));dr.appendChild(td);tbody.insertBefore(dr,tr.nextSibling);fetch('/api/list-items?admin='+ADMIN+'&lsid='+encodeURIComponent(lsid)).then(function(r){return r.json();}).then(function(data){td.innerHTML='';var items=data.items||[];var tools=el('div',{class:'rowtools'});var saveBtn=el('button',{text:'Save order'});var resetBtn=el('button',{text:'Reset order'});var fullBtn=el('button',{text:'Full reset'});tools.appendChild(saveBtn);tools.appendChild(resetBtn);tools.appendChild(fullBtn);td.appendChild(tools);var optsWrap=el('div',{class:'rowtools'});optsWrap.appendChild(el('span',{class:'mini muted',text:'Sort options in Stremio:'}));var current=(prefs.sortOptions&&prefs.sortOptions[lsid]&&prefs.sortOptions[lsid].length)?new Set(prefs.sortOptions[lsid]):new Set(SORT_OPTIONS);SORT_OPTIONS.forEach(function(opt){var lab=el('label',{class:'pill'});var cb2=document.createElement('input');cb2.type='checkbox';cb2.checked=current.has(opt);cb2.onchange=function(){var arr=[];var checks=optsWrap.querySelectorAll('input');for(var i=0;i<checks.length;i++){if(checks[i].checked)arr.push(SORT_OPTIONS[i]);}prefs.sortOptions=prefs.sortOptions||{};prefs.sortOptions[lsid]=arr.length?arr:SORT_OPTIONS.slice();};lab.appendChild(cb2);lab.appendChild(el('span',{text:opt}));optsWrap.appendChild(lab);});td.appendChild(optsWrap);var shapeRow=el('div',{class:'rowtools'});shapeRow.appendChild(el('span',{class:'mini muted',text:'Poster shape:'}));var currentShape=prefs.posterShape[lsid]||'poster';['poster','landscape'].forEach(function(shape){var lab=el('label',{class:'pill'});var rb=document.createElement('input');rb.type='radio';rb.name='shape-'+lsid;rb.value=shape;if(shape===currentShape)rb.checked=true;rb.onchange=function(){prefs.posterShape[lsid]=shape;};lab.appendChild(rb);lab.appendChild(el('span',{text:shape}));shapeRow.appendChild(lab);});td.appendChild(shapeRow);var ul=el('ul',{class:'thumbs shape-'+(currentShape||'poster')});items.forEach(function(it){var li=el('li',{class:'thumb','data-id':it.id});li.setAttribute('draggable','true');var img=document.createElement('img');img.className='thumb-img';img.src=it.posterPortrait||it.poster||'';li.appendChild(img);var box=el('div',{},[el('div',{class:'title',text:it.name||it.id}),el('div',{class:'id',text:it.id})]);li.appendChild(box);var del=el('div',{class:'del',text:'×'});del.onclick=function(){li.parentNode.removeChild(li);};li.appendChild(del);ul.appendChild(li);});var addLi=el('li',{class:'thumb add','data-add':'1'});var addBox=el('div',{class:'addbox'});addBox.appendChild(el('div',{class:'mini muted',text:'Add IMDb id (tt...)'}));var input=document.createElement('input');input.placeholder='tt1234567 or URL';input.onkeydown=function(ev){if(ev.key==='Enter'){ev.preventDefault();if(!input.value)return;fetch('/api/list-add?admin='+ADMIN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lsid:lsid,id:input.value})}).then(function(){location.reload();});}};addBox.appendChild(input);addLi.appendChild(addBox);ul.appendChild(addLi);td.appendChild(ul);attachThumbDnD(ul);saveBtn.onclick=function(e){e.preventDefault();var ids=[];ul.querySelectorAll('li.thumb').forEach(function(li){var id=li.getAttribute('data-id');if(id)ids.push(id);});fetch('/api/custom-order?admin='+ADMIN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lsid:lsid,order:ids})}).then(function(){alert('Saved custom order (default sort set to custom).');});};resetBtn.onclick=function(e){e.preventDefault();fetch('/api/custom-order?admin='+ADMIN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lsid:lsid,order:[]})}).then(function(){alert('Cleared custom order (list will use default sort).');});};fullBtn.onclick=function(e){e.preventDefault();if(!confirm('Clear custom order and all add/remove edits for this list?'))return;fetch('/api/list-reset?admin='+ADMIN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lsid:lsid})}).then(function(){location.reload();});};});});});table.appendChild(tbody);attachRowDnD(tbody);var saveRow=el('div',{class:'rowtools'});var saveBtnAll=el('button',{text:'Save layout'});saveBtnAll.onclick=function(e){e.preventDefault();var rowsArr=[];tbody.querySelectorAll('tr[data-lsid]').forEach(function(tr){rowsArr.push(tr.getAttribute('data-lsid'));});var enabled=[];rowsArr.forEach(function(id){if(tbody.querySelector('tr[data-lsid=\"'+id+'\"] input[type=\"checkbox\"]').checked)enabled.push(id);});var body={enabled:enabled,order:rowsArr,perListSort:prefs.perListSort,sortOptions:prefs.sortOptions,posterShape:prefs.posterShape,upgradeEpisodes:prefs.upgradeEpisodes,sources:prefs.sources,blocked:prefs.blocked,customOrder:prefs.customOrder};fetch('/api/prefs?admin='+ADMIN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(){alert('Saved layout');location.reload();});};saveRow.appendChild(saveBtnAll);container.appendChild(table);container.appendChild(saveRow);}" +

"function savePrefs(){var prefs=BOOT_PREFS;var body={enabled:prefs.enabled,order:prefs.order,perListSort:prefs.perListSort,sortOptions:prefs.sortOptions,posterShape:prefs.posterShape,upgradeEpisodes:prefs.upgradeEpisodes,sources:prefs.sources,blocked:prefs.blocked,customOrder:prefs.customOrder};fetch('/api/prefs?admin='+ADMIN,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(){location.reload();});}" +

"document.addEventListener('DOMContentLoaded',function(){var btn=document.getElementById('installBtn');if(btn){btn.onclick=function(e){e.preventDefault();var url=HOST_URL.replace(/^https?:/,'stremio:')+'/manifest.json';if(SECRET)url+='?key='+SECRET;window.location.href=url;};}document.querySelectorAll('.navtab').forEach(function(b){b.addEventListener('click',function(){setView(b.getAttribute('data-view'));});});var userBtn=document.getElementById('addUser');var listBtn=document.getElementById('addList');var userInp=document.getElementById('userInput');var listInp=document.getElementById('listInput');if(userBtn)userBtn.onclick=function(e){e.preventDefault();var url=normalizeUserListsUrl(userInp.value);if(!url){alert('Enter a valid IMDb or Trakt user /lists URL');return;}addSources({users:[url],lists:[]});};if(listBtn)listBtn.onclick=function(e){e.preventDefault();var url=normalizeListIdOrUrl2(listInp.value);if(!url){alert('Enter a valid IMDb or Trakt list URL');return;}addSources({users:[],lists:[url]});};buildAddTab();buildCustomize();});" +
"</script></body></html>"
  );
});

// ------- BOOT -------
(async () => {
  try {
    const snap = await loadSnapshot();
    if (snap) {
      LISTS = snap.lists || {};
      PREFS = snap.prefs || PREFS;
      if (snap.fallback) {
        Object.entries(snap.fallback).forEach(([k,v])=>FALLBK.set(k,v));
      }
      if (snap.cards) {
        Object.entries(snap.cards).forEach(([k,v])=>CARD.set(k,v));
      }
      if (snap.ep2ser) {
        Object.entries(snap.ep2ser).forEach(([k,v])=>EP2SER.set(k,v));
      }
      LAST_SYNC_AT   = snap.lastSyncAt || 0;
      MANIFEST_REV   = snap.manifestRev || 1;
      LAST_MANIFEST_KEY = manifestKey();
      console.log("[BOOT] Loaded snapshot with " + Object.keys(LISTS).length + " lists.");
      maybeBackgroundSync();
    } else {
      console.log("[BOOT] No snapshot found, will run initial sync.");
      await fullSync({ rediscover:true });
      scheduleNextSync();
    }
  } catch (e) {
    console.error("[BOOT] error loading snapshot:", e);
  }

  app.listen(PORT, HOST, () => {
    console.log("[BOOT] My Lists addon v" + baseManifest.version + " listening on http://" + HOST + ":" + PORT);
  });
})();
