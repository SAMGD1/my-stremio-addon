/*  My Lists – IMDb → Stremio (custom per-list ordering, IMDb date order, sources & UI)
 *  v12.4.0 + Trakt list support + UI Revamp + Landscape support
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

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/12.4.0";
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
 *   - IMDb list:  "ls123456789"
 *   - Trakt list: "trakt:username:slug"
 */
let LISTS = Object.create(null);

/** PREFS saved to snapshot */
let PREFS = {
  listEdits: {},          // { [listId]: { added: ["tt..."], removed: ["tt..."] } }
  enabled: [],            // listIds shown in Stremio
  order: [],              // listIds order in manifest
  defaultList: "",
  perListSort: {},        // { listId: 'date_asc' | ... | 'custom' }
  sortOptions: {},        // { listId: ['custom', 'date_desc', ...] } -> controls Stremio dropdown
  posterShapes: {},       // { listId: 'poster' | 'landscape' } -> controls Stremio display shape
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

function makeTraktListKey(user, slug) {
  return `trakt:${user}:${slug}`;
}
function parseTraktListKey(id) {
  const m = String(id || "").match(/^trakt:([^:]+):(.+)$/i);
  return m ? { user: m[1], slug: m[2] } : null;
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
function parseTraktListUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/trakt\.tv\/users\/([^/]+)\/lists\/([^\/?#]+)/i);
  if (!m) return null;
  const user = decodeURIComponent(m[1]);
  const slug = decodeURIComponent(m[2]);
  return { user, slug };
}

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

async function fetchTraktListMeta(user, slug) {
  try {
    const data = await traktJson(`/users/${encodeURIComponent(user)}/lists/${encodeURIComponent(slug)}`);
    if (!data) return null;
    return {
      name: data.name || `${user}/${slug}`,
      url: `https://trakt.tv/users/${user}/lists/${slug}`
    };
  } catch (e) {
    console.warn("[TRAKT] list meta failed", user, slug, e.message);
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

  for (const { key, prop } of types) {
    let page = 1;
    while (true) {
      let items;
      try {
        items = await traktJson(`/users/${encodeURIComponent(user)}/lists/${encodeURIComponent(slug)}/items/${key}?page=${page}&limit=100`);
      } catch (e) {
        console.warn("[TRAKT] items fetch failed", user, slug, key, e.message);
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

async function fetchImdbListIdsAllPages(listUrl, maxPages = 80) {
  const seen = new Set();
  const ids  = [];

  const baseUrl = new URL(listUrl);
  baseUrl.searchParams.set("mode", "detail");
  baseUrl.searchParams.delete("page");

  try {
    const firstUrl = withParam(baseUrl.toString(), "_", Date.now());
    const html1 = await fetchText(firstUrl);
    const found1 = tconstsFromHtml(html1);
    let added1 = 0;
    for (const tt of found1) {
      if (!seen.has(tt)) {
        seen.add(tt);
        ids.push(tt);
        added1++;
      }
    }
    if (!added1) return ids;
  } catch (e) {
    console.warn("[IMDb] page 1 fetch failed:", e.message);
    return ids;
  }

  for (let page = 2; page <= maxPages; page++) {
    let html;
    try {
      let u = new URL(baseUrl.toString());
      u.searchParams.set("page", String(page));
      u.searchParams.set("_", Date.now().toString());
      html = await fetchText(u.toString());
    } catch (e) {
      console.warn("[IMDb] page fetch failed", listUrl, "page", page, e.message);
      break;
    }

    const found = tconstsFromHtml(html);
    if (!found.length) break;

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

async function fetchImdbOrder(listUrl, sortSpec, maxPages = 80) {
  const seen = new Set();
  const ids  = [];
  const baseUrl = new URL(listUrl);
  baseUrl.searchParams.set("mode", "detail");
  baseUrl.searchParams.set("sort", sortSpec);
  baseUrl.searchParams.delete("page");

  try {
    const firstUrl = withParam(baseUrl.toString(), "_", Date.now());
    const html1 = await fetchText(firstUrl);
    const found1 = tconstsFromHtml(html1);
    for (const tt of found1) {
      if (!seen.has(tt)) {
        seen.add(tt);
        ids.push(tt);
      }
    }
    if (!found1.length) return ids;
  } catch (e) {
    console.warn("[IMDb] order page 1 failed", listUrl, sortSpec, e.message);
    return ids;
  }

  for (let page = 2; page <= maxPages; page++) {
    let html;
    try {
      let u = new URL(baseUrl.toString());
      u.searchParams.set("page", String(page));
      u.searchParams.set("_", Date.now().toString());
      html = await fetchText(u.toString());
    } catch (e) {
      console.warn("[IMDb] order page fetch failed", listUrl, sortSpec, "page", page, e.message);
      break;
    }

    const found = tconstsFromHtml(html);
    if (!found.length) break;

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
  if (name || poster) FALLBK.set(imdbId, { name, poster, releaseDate: released, year, type: rec.kind });
  return rec;
}
function cardFor(imdbId) {
  const rec = BEST.get(imdbId) || { kind: null, meta: null };
  const m = rec.meta || {}; const fb = FALLBK.get(imdbId) || {};
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
  const names = enabled.map(id => LISTS[id]?.name || id).sort().join("|");
  const perSort = JSON.stringify(PREFS.perListSort || {});
  const perOpts = JSON.stringify(PREFS.sortOptions || {});
  const shapes = JSON.stringify(PREFS.posterShapes || {});
  const custom = Object.keys(PREFS.customOrder || {}).length;
  const order = (PREFS.order || []).join(",");
  return `${enabled.join(",")}#${order}#${PREFS.defaultList}#${names}#${perSort}#${perOpts}#${shapes}#c${custom}`;
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

    const tinfo = parseTraktListUrl(val);
    if (tinfo) {
      if (!TRAKT_CLIENT_ID) {
        console.warn("[TRAKT] got list", val, "but TRAKT_CLIENT_ID is not set – ignoring.");
        continue;
      }
      const key = makeTraktListKey(tinfo.user, tinfo.slug);
      if (blocked.has(key)) continue;
      let name = key;
      try { const meta = await fetchTraktListMeta(tinfo.user, tinfo.slug); if (meta) name = meta.name || name; }
      catch (e) { console.warn("[TRAKT] meta fetch failed for", val, e.message); }
      add({ id: key, url: `https://trakt.tv/users/${tinfo.user}/lists/${tinfo.slug}`, name });
      await sleep(60);
      continue;
    }

    const norm = normalizeListIdOrUrl(val);
    if (!norm) continue;
    let { id, url } = norm;
    if (!id) { const m = String(url).match(/ls\d{6,}/i); if (m) id = m[0]; }
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
    if (rediscover) discovered = await harvestSources();
    if ((!discovered || !discovered.length) && IMDB_LIST_IDS.length) {
      discovered = IMDB_LIST_IDS.map(id => ({ id, name: id, url: `https://www.imdb.com/list/${id}/` }));
      console.log(`[DISCOVER] used IMDB_LIST_IDS fallback (${discovered.length})`);
    }

    const next = Object.create(null);
    const seen = new Set();
    for (const d of discovered) {
      next[d.id] = { id: d.id, name: d.name || d.id, url: d.url, ids: [], orders: d.orders || {} };
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
        const ts = parseTraktListKey(id);
        if (ts && TRAKT_CLIENT_ID) {
          try { raw = await fetchTraktListImdbIds(ts.user, ts.slug); }
          catch (e) { console.warn("[SYNC] Trakt fetch failed for", id, e.message); }
        }
      } else {
        const url = list.url || `https://www.imdb.com/list/${id}/`;
        try { raw = await fetchImdbListIdsAllPages(url); }
        catch (e) { console.warn("[SYNC] IMDb list fetch failed for", id, e.message); }
        if (IMDB_FETCH_RELEASE_ORDERS && isImdbListId(id)) {
          try {
            const asc  = await fetchImdbOrder(url, "release_date,asc");
            const desc = await fetchImdbOrder(url, "release_date,desc");
            list.orders = list.orders || {};
            list.orders.date_asc  = asc.slice();
            list.orders.date_desc = desc.slice();
            asc.forEach(tt => uniques.add(tt));
            desc.forEach(tt => uniques.add(tt));
          } catch (e) { console.warn("[SYNC] release_date sort fetch failed for", id, e.message); }
        }
      }
      list.ids = raw.slice();
      raw.forEach(tt => uniques.add(tt));
      await sleep(60);
    }

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

    for (const tt of idsToPreload) { await getBestMeta(tt); CARD.set(tt, cardFor(tt)); }

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
  version: "12.4.0",
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
    ],
    // Respect per-list poster shape preference. Default is "poster".
    posterShape: (PREFS.posterShapes && PREFS.posterShapes[lsid]) === "landscape" ? "landscape" : "poster"
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
    res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
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
    PREFS.posterShapes    = body.posterShapes && typeof body.posterShapes === "object" ? body.posterShapes : (PREFS.posterShapes || {});
    PREFS.sortOptions     = body.sortOptions && typeof body.sortOptions === "object" ? Object.fromEntries(Object.entries(body.sortOptions).map(([k,v])=>[k,clampSortOptions(v)])) : (PREFS.sortOptions || {});
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
    await getBestMeta(tt); CARD.set(tt, cardFor(tt));
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
    res.status(200).send(`Synced at ${new Date().toISOString()}`);
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
    res.status(200).send(`Purged & synced at ${new Date().toISOString()}`);
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

// ------- Admin page (sources + add/remove + true IMDb sorting in drawer) -------
app.get("/admin", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  const base = absoluteBase(req);
  const manifestUrl = `${base}/manifest.json${SHARED_SECRET?`?key=${SHARED_SECRET}`:""}`;
  let discovered = [];
  try { discovered = await harvestSources(); } catch {}

  const disc = discovered.map(d=>`<li class="text-sm text-gray-400"><strong class="text-gray-200">${d.name||d.id}</strong><br/>${d.url}</li>`).join("") || "<li class='text-gray-500 text-sm'>(none)</li>";

  const lastSyncText = LAST_SYNC_AT
    ? (new Date(LAST_SYNC_AT).toLocaleString() + " (" + Math.round((Date.now()-LAST_SYNC_AT)/60000) + " min ago)")
    : "never";

  res.type("html").send(`<!doctype html>
<html class="dark">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Admin</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { background-color: #0f172a; color: #e2e8f0; }
  .scroll-bar::-webkit-scrollbar { width: 8px; height: 8px; }
  .scroll-bar::-webkit-scrollbar-track { background: #1e293b; }
  .scroll-bar::-webkit-scrollbar-thumb { background: #475569; border-radius: 4px; }
  .thumb.dragging { opacity: 0.5; border: 2px dashed #6366f1; }
  tr.dragging { opacity: 0.5; background: #1e293b; }
</style>
</head>
<body class="min-h-screen p-4 md:p-8 font-sans">

  <div class="max-w-6xl mx-auto space-y-6">
    <!-- Header -->
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div>
        <h1 class="text-3xl font-bold text-white tracking-tight">My Lists <span class="text-indigo-400 text-lg font-normal">Admin</span></h1>
        <p class="text-slate-400 text-sm mt-1">Last sync: <span id="lastSync">${lastSyncText}</span> (Auto: ${IMDB_SYNC_MINUTES} min)</p>
      </div>
      <div class="flex gap-3">
        <button id="installBtn" class="bg-green-600 hover:bg-green-500 text-white font-medium px-4 py-2 rounded-lg shadow-lg transition flex items-center gap-2">
          <span>🚀 Install to Stremio</span>
        </button>
        <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}" class="inline">
          <button class="bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-4 py-2 rounded-lg shadow-lg transition">Sync Now</button>
        </form>
        <form method="POST" action="/api/purge-sync?admin=${ADMIN_PASSWORD}" onsubmit="return confirm('Purge & re-sync everything?')">
           <button class="bg-red-900/50 hover:bg-red-800 text-red-200 border border-red-800 font-medium px-3 py-2 rounded-lg transition text-sm h-full">Purge</button>
        </form>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- Sources Card -->
      <div class="bg-slate-800/50 border border-slate-700 rounded-xl p-6 shadow-xl lg:col-span-1 h-fit">
        <h3 class="text-xl font-semibold text-white mb-4 border-b border-slate-700 pb-2">Sources & Discovery</h3>
        
        <div class="space-y-4">
          <div>
             <label class="block text-xs font-medium text-slate-400 uppercase tracking-wider mb-1">Add IMDb User URL</label>
             <div class="flex gap-2">
               <input id="userInput" class="flex-1 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-500" placeholder="https://imdb.com/user/ur.../lists/" />
               <button id="addUser" class="bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded text-sm">Add</button>
             </div>
          </div>

          <div>
             <label class="block text-xs font-medium text-slate-400 uppercase tracking-wider mb-1">Add List URL (IMDb/Trakt)</label>
             <div class="flex gap-2">
               <input id="listInput" class="flex-1 bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm focus:outline-none focus:border-indigo-500" placeholder="IMDb ls... or Trakt URL" />
               <button id="addList" class="bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded text-sm">Add</button>
             </div>
          </div>

          <div class="space-y-2 pt-2">
            <div class="text-xs text-slate-500">Your Extra Sources:</div>
            <div id="userPills" class="flex flex-wrap gap-2 text-sm"></div>
            <div id="listPills" class="flex flex-wrap gap-2 text-sm"></div>
          </div>

          <div class="pt-4 border-t border-slate-700">
             <div class="text-xs text-slate-500 mb-2">Discovered from sources:</div>
             <ul class="space-y-2 max-h-40 overflow-y-auto scroll-bar pr-2">${disc}</ul>
          </div>

          <div class="pt-2">
             <div class="text-xs text-slate-500 mb-2">Blocked Lists:</div>
             <div id="blockedPills" class="flex flex-wrap gap-2 text-sm"></div>
          </div>
        </div>
      </div>

      <!-- Main Lists Card -->
      <div class="bg-slate-800/50 border border-slate-700 rounded-xl p-6 shadow-xl lg:col-span-2">
        <div class="flex justify-between items-center mb-4 border-b border-slate-700 pb-2">
           <h3 class="text-xl font-semibold text-white">Managed Lists</h3>
           <button id="saveBtn" class="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded-lg font-bold shadow-lg transition">Save All Changes</button>
        </div>
        
        <p class="text-sm text-slate-400 mb-4">
          Drag to reorder. Use the toggle to switch between <b>Poster</b> and <b>Landscape</b> shapes in Stremio. 
          Click <span class="text-indigo-400">▾</span> to customize content/sorting.
        </p>

        <div id="prefs" class="overflow-x-auto"></div>
        <div id="saveMsg" class="text-center text-green-400 h-6 mt-2 text-sm font-medium"></div>
      </div>
    </div>

    <div class="text-center text-xs text-slate-600 pt-8 pb-4">
      Manifest: <span class="font-mono select-all bg-slate-800 px-1 rounded">${manifestUrl}</span>
    </div>
  </div>

<script>
const ADMIN="${ADMIN_PASSWORD}";
const SORT_OPTIONS = ${JSON.stringify(SORT_OPTIONS)};
const HOST_URL = "${absoluteBase(req)}";

// --- Install Button Logic ---
document.getElementById('installBtn').onclick = (e) => {
  e.preventDefault();
  let url = HOST_URL.replace(/^https?:/, 'stremio:') + '/manifest.json';
  if ("${SHARED_SECRET}") url += '?key=${SHARED_SECRET}';
  window.location.href = url;
};

async function getPrefs(){ const r = await fetch('/api/prefs?admin='+ADMIN); return r.json(); }
async function getLists(){ const r = await fetch('/api/lists?admin='+ADMIN); return r.json(); }
async function getListItems(lsid){ const r = await fetch('/api/list-items?admin='+ADMIN+'&lsid='+encodeURIComponent(lsid)); return r.json(); }
async function saveCustomOrder(lsid, order){
  const r = await fetch('/api/custom-order?admin='+ADMIN, {method:'POST',headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid, order })});
  if (!r.ok) throw new Error('save failed');
  return r.json();
}

// --- Helpers ---
function normalizeUserListsUrl(v){
  v = String(v||'').trim(); if (!v) return null;
  if (/imdb\\.com\\/user\\/ur\\d+\\/lists/i.test(v)) return v;
  const m = v.match(/ur\\d{6,}/i); return m ? 'https://www.imdb.com/user/'+m[0]+'/lists/' : null;
}
function normalizeListIdOrUrl2(v){
  v = String(v||'').trim(); if (!v) return null;
  if (/trakt\\.tv\\/users\\/[^/]+\\/lists\\/[^/?#]+/i.test(v)) return v;
  if (/imdb\\.com\\/list\\/ls\\d{6,}/i.test(v)) return v;
  const m = v.match(/ls\\d{6,}/i); return m ? 'https://www.imdb.com/list/'+m[0]+'/' : null;
}
async function addSources(payload){
  await fetch('/api/add-sources?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
}
function wireAddButtons(){
  const userBtn = document.getElementById('addUser');
  const listBtn = document.getElementById('addList');
  const userInp = document.getElementById('userInput');
  const listInp = document.getElementById('listInput');

  userBtn.onclick = async (e) => {
    e.preventDefault();
    const url = normalizeUserListsUrl(userInp.value);
    if (!url) { alert('Enter a valid IMDb user /lists URL or ur… id'); return; }
    userBtn.disabled = true; userBtn.innerText = '...';
    try { await addSources({ users:[url], lists:[] }); location.reload(); } finally { userBtn.disabled = false; }
  };

  listBtn.onclick = async (e) => {
    e.preventDefault();
    const url = normalizeListIdOrUrl2(listInp.value);
    if (!url) { alert('Enter a valid IMDb list URL, ls… id, or Trakt list URL'); return; }
    listBtn.disabled = true; listBtn.innerText = '...';
    try { await addSources({ users:[], lists:[url] }); location.reload(); } finally { listBtn.disabled = false; }
  };
}

function el(tag, attrs={}, kids=[]) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === "text") e.textContent = attrs[k];
    else if (k === "html") e.innerHTML = attrs[k];
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  kids.forEach(ch => e.appendChild(ch));
  return e;
}

function attachDnD(elem, selector, callback) {
  let src = null;
  elem.addEventListener('dragstart', e => {
    const t = e.target.closest(selector);
    if (!t || (t.tagName==='LI' && t.hasAttribute('data-add'))) return;
    src = t; t.classList.add('dragging');
    e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain','');
  });
  elem.addEventListener('dragend', () => { if(src) src.classList.remove('dragging'); src=null; if(callback) callback(); });
  elem.addEventListener('dragover', e => {
    e.preventDefault(); if(!src) return;
    const over = e.target.closest(selector);
    if(!over || over===src || (over.tagName==='LI' && over.hasAttribute('data-add'))) return;
    const rect = over.getBoundingClientRect();
    const next = (e.clientY - rect.top) > (rect.height/2);
    over.parentNode.insertBefore(src, next ? over.nextSibling : over);
  });
}

// --- Rendering ---
async function render() {
  const prefs = await getPrefs();
  const lists = await getLists();
  
  // Render Pills
  const pillClass = "inline-flex items-center gap-2 bg-slate-900 border border-slate-600 rounded-full px-3 py-1 text-xs text-slate-300";
  function renderPills(id, arr, onRemove){
    const wrap = document.getElementById(id); wrap.innerHTML = '';
    if (!arr || !arr.length) { wrap.innerHTML = '<span class="text-slate-600 italic">(none)</span>'; return; }
    arr.forEach((txt, idx)=>{
      const pill = el('span', {class: pillClass}, [
        el('span',{text:txt.length > 30 ? txt.slice(0,28)+'...' : txt}),
        el('button',{class:'text-red-400 hover:text-red-300 font-bold', text:'✕', onclick:()=>onRemove(idx)})
      ]);
      wrap.appendChild(pill);
    });
  }
  renderPills('userPills', prefs.sources?.users || [], (i)=> { prefs.sources.users.splice(i,1); saveAll('Removed source'); });
  renderPills('listPills', prefs.sources?.lists || [], (i)=> { prefs.sources.lists.splice(i,1); saveAll('Removed source'); });

  // Blocked Pills
  const blockedWrap = document.getElementById('blockedPills'); blockedWrap.innerHTML = '';
  const blocked = prefs.blocked || [];
  if (!blocked.length) blockedWrap.innerHTML = '<span class="text-slate-600 italic">(none)</span>';
  blocked.forEach(lsid=>{
     const pill = el('span', {class: pillClass + " border-red-900/50 bg-red-900/20"}, [
        el('span',{text:lsid}),
        el('button',{class:'text-green-400 hover:text-green-300 font-bold ml-1', text:'Unblock', onclick:async ()=>{
           await fetch('/api/unblock-list?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid })});
           location.reload();
        }})
      ]);
      blockedWrap.appendChild(pill);
  });

  // --- Main Table ---
  const container = document.getElementById('prefs'); container.innerHTML = "";
  const table = el('table', {class: 'w-full text-left border-collapse'});
  const thead = el('thead', {class: 'bg-slate-900/50 text-xs uppercase text-slate-500 font-medium'}, [
     el('tr',{}, [
       el('th',{class:'p-3 rounded-tl-lg', text:''}), // Drag
       el('th',{class:'p-3', text:'Active'}),
       el('th',{class:'p-3', text:'List Name'}),
       el('th',{class:'p-3', text:'Count'}),
       el('th',{class:'p-3', text:'Sort'}),
       el('th',{class:'p-3', text:'Shape'}), // New
       el('th',{class:'p-3 rounded-tr-lg', text:''}) // Remove
     ])
  ]);
  const tbody = el('tbody', {class: 'text-sm divide-y divide-slate-700'});
  table.appendChild(thead); table.appendChild(tbody);

  // Ordering logic
  const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));
  const baseOrder = (prefs.order && prefs.order.length ? prefs.order.filter(id => lists[id]) : []);
  const missing   = Object.keys(lists).filter(id => !baseOrder.includes(id)).sort((a,b)=>( (lists[a]?.name||a).localeCompare(lists[b]?.name||b) ));
  const order = baseOrder.concat(missing);

  function makeRow(lsid) {
    const L = lists[lsid];
    const tr = el('tr', {'data-lsid': lsid, class:'group hover:bg-slate-800/50 transition'});

    // 1. Drag/Expand
    const chev = el('button',{class:'text-xl text-slate-500 hover:text-indigo-400 transition px-2', text:'▸'});
    const drag = el('span',{class:'cursor-grab text-slate-600 hover:text-slate-400 text-lg px-1 select-none', text:'⋮⋮'});
    const td1 = el('td',{class:'p-3 w-12'}, [ el('div',{class:'flex items-center gap-1'},[drag, chev]) ]);

    // 2. Checkbox
    const cb = el('input', {type:'checkbox', class:'w-4 h-4 rounded border-slate-600 bg-slate-700 text-indigo-600 focus:ring-indigo-500'}); 
    cb.checked = enabledSet.has(lsid);
    cb.onchange = ()=>{ if (cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); };
    const td2 = el('td',{class:'p-3 w-12 text-center'},[cb]);

    // 3. Name
    const td3 = el('td',{class:'p-3'}, [
      el('div',{class:'font-medium text-slate-200', text: L.name||lsid}),
      el('div',{class:'text-xs text-slate-500 font-mono', text: lsid})
    ]);

    // 4. Count
    const count = (L.ids||[]).length;
    const td4 = el('td',{class:'p-3 text-slate-400'}, [ el('span',{class:'bg-slate-800 px-2 py-1 rounded text-xs'},[text=String(count)]) ]);

    // 5. Sort Select
    const sel = el('select', {class:'bg-slate-900 border border-slate-700 rounded text-xs py-1 px-2 focus:border-indigo-500 outline-none'});
    SORT_OPTIONS.forEach(o => {
      const opt = el('option',{value:o, text:o});
      if (o === ((prefs.perListSort && prefs.perListSort[lsid]) || "name_asc")) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = () => {
       prefs.perListSort = prefs.perListSort || {}; 
       prefs.perListSort[lsid] = sel.value;
       // Reset drawer if open
       const drawer = document.querySelector('tr[data-drawer="'+lsid+'"]');
       if (drawer && !drawer.hidden) drawer.querySelector('.reset-btn')?.click();
    };
    const td5 = el('td',{class:'p-3'},[sel]);

    // 6. Shape Toggle (New Feature)
    const currentShape = (prefs.posterShapes && prefs.posterShapes[lsid]) || "poster";
    const shapeBtn = el('button', {
      class: 'bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs hover:bg-slate-800 transition flex items-center gap-2 w-24 justify-center',
      title: 'Toggle between Poster (Portrait) and Landscape'
    });
    const updateShapeBtn = (s) => {
       if (s === 'landscape') {
         shapeBtn.innerHTML = '<span class="text-indigo-400 text-base">▬</span> <span>Land</span>';
       } else {
         shapeBtn.innerHTML = '<span class="text-indigo-400 text-base">▮</span> <span>Poster</span>';
       }
    };
    updateShapeBtn(currentShape);
    shapeBtn.onclick = (e) => {
       e.preventDefault();
       prefs.posterShapes = prefs.posterShapes || {};
       const now = prefs.posterShapes[lsid] || 'poster';
       const next = now === 'poster' ? 'landscape' : 'poster';
       prefs.posterShapes[lsid] = next;
       updateShapeBtn(next);
    };
    const td6 = el('td',{class:'p-3'},[shapeBtn]);

    // 7. Remove
    const rmBtn = el('button',{class:'text-slate-500 hover:text-red-400 transition', title:'Remove List'}, [el('span',{text:'🗑'})]);
    rmBtn.onclick = () => {
       if (!confirm('Remove this list and block it from reappearing?')) return;
       fetch('/api/remove-list?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid })})
         .then(()=> location.reload()).catch(()=> alert('Remove failed'));
    };
    const td7 = el('td',{class:'p-3 text-center'},[rmBtn]);

    tr.append(td1, td2, td3, td4, td5, td6, td7);

    // Drawer Logic
    let drawerRow = null;
    chev.onclick = () => {
       if (drawerRow) {
         const isHidden = drawerRow.classList.contains('hidden');
         if (isHidden) { drawerRow.classList.remove('hidden'); chev.innerText = '▾'; } 
         else { drawerRow.classList.add('hidden'); chev.innerText = '▸'; }
       } else {
         chev.innerText = '▾';
         drawerRow = makeDrawer(lsid, L);
         tr.after(drawerRow);
       }
    };

    return tr;
  }

  function makeDrawer(lsid, L) {
    const tr = el('tr',{class:'bg-slate-900/30 border-b border-slate-800', 'data-drawer': lsid});
    const td = el('td',{colspan: 7, class:'p-4'});
    tr.appendChild(td);
    
    td.innerHTML = '<div class="text-center py-4 text-slate-500">Loading items...</div>';

    getListItems(lsid).then(({items}) => {
      td.innerHTML = '';
      
      // Controls
      const controls = el('div',{class:'flex flex-wrap gap-4 items-center justify-between mb-4'});
      
      // Left: Sort Options
      const optsDiv = el('div',{class:'flex items-center gap-2 text-sm'});
      optsDiv.innerHTML = '<span class="text-slate-500">Stremio sort options:</span>';
      const currentOpts = new Set((prefs.sortOptions && prefs.sortOptions[lsid]) || SORT_OPTIONS);
      SORT_OPTIONS.forEach(opt => {
         const lab = el('label',{class:'inline-flex items-center gap-1 bg-slate-800 px-2 py-1 rounded cursor-pointer select-none hover:bg-slate-700 border border-slate-700'});
         const chk = el('input',{type:'checkbox', class:'rounded bg-slate-900 border-slate-600 text-indigo-500 focus:ring-0 w-3 h-3'});
         chk.checked = currentOpts.has(opt);
         chk.onchange = () => {
            const all = Array.from(optsDiv.querySelectorAll('input')).map((c,i) => c.checked ? SORT_OPTIONS[i] : null).filter(Boolean);
            prefs.sortOptions = prefs.sortOptions || {};
            prefs.sortOptions[lsid] = all.length ? all : SORT_OPTIONS.slice();
         };
         lab.append(chk, el('span',{text:opt, class:'text-slate-300'}));
         optsDiv.appendChild(lab);
      });
      
      // Right: Actions
      const actsDiv = el('div',{class:'flex gap-2'});
      const saveOrderBtn = el('button',{class:'bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-3 py-2 rounded shadow', text:'Save Custom Order'});
      const resetOrderBtn = el('button',{class:'reset-btn bg-slate-700 hover:bg-slate-600 text-white text-xs px-3 py-2 rounded', text:'Reset View'});
      const resetAllBtn = el('button',{class:'bg-red-900/40 border border-red-800/50 text-red-300 hover:bg-red-900/60 text-xs px-3 py-2 rounded', text:'Hard Reset'});
      actsDiv.append(saveOrderBtn, resetOrderBtn, resetAllBtn);
      
      controls.append(optsDiv, actsDiv);
      td.appendChild(controls);

      // Grid
      const ul = el('ul',{class:'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3'});
      td.appendChild(ul);

      const imdbIndex = new Map((L.ids || []).map((id,i)=>[id,i]));

      function renderGrid(listItems) {
         ul.innerHTML = '';
         listItems.forEach(it => {
            const li = el('li',{class:'thumb group relative aspect-[2/3] bg-slate-800 rounded overflow-hidden border border-slate-700 cursor-grab', 'data-id':it.id, draggable:true});
            // Img
            if (it.poster) li.appendChild(el('img',{src:it.poster, class:'w-full h-full object-cover opacity-80 group-hover:opacity-100 transition'}));
            else li.appendChild(el('div',{class:'w-full h-full flex items-center justify-center text-slate-600 text-xs p-2 text-center', text:it.name}));
            // Overlay
            const over = el('div',{class:'absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition p-2 flex flex-col justify-end'});
            over.append(el('div',{class:'text-white text-xs font-bold leading-tight line-clamp-2', text:it.name}));
            over.append(el('div',{class:'text-slate-400 text-[10px] font-mono', text:it.id}));
            li.appendChild(over);
            // Delete
            const del = el('button',{class:'absolute top-1 right-1 bg-black/50 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition', text:'×'});
            del.onclick = async (e) => {
               e.stopPropagation();
               if(!confirm('Remove item?')) return;
               await fetch('/api/list-remove?admin='+ADMIN, {method:'POST',headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid, id: it.id })});
               refreshDrawer();
            };
            li.appendChild(del);
            ul.appendChild(li);
         });
         
         // Add Tile
         const addLi = el('li',{class:'aspect-[2/3] bg-slate-800/50 border-2 border-dashed border-slate-700 rounded flex flex-col items-center justify-center p-2 gap-2 hover:border-indigo-500 transition', 'data-add':true});
         const inp = el('input',{class:'w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-center focus:border-indigo-500 outline-none', placeholder:'tt123...'});
         inp.onkeydown = async (e) => {
            if(e.key==='Enter'){
               const v = inp.value.trim().match(/(tt\d{7,})/);
               if(!v) return alert('Invalid ID');
               inp.disabled=true;
               await fetch('/api/list-add?admin='+ADMIN, {method:'POST',headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid, id: v[1] })});
               inp.value=''; inp.disabled=false; refreshDrawer();
            }
         };
         addLi.append(el('span',{class:'text-2xl text-slate-600', text:'+'}), inp);
         ul.appendChild(addLi);
         
         attachDnD(ul, 'li', null);
      }

      function getSorted(key) {
         let arr = items.slice();
         if (key==='custom' && prefs.customOrder?.[lsid]) {
            const pos = new Map(prefs.customOrder[lsid].map((id,i)=>[id,i]));
            arr.sort((a,b)=>(pos.get(a.id)??1e9) - (pos.get(b.id)??1e9));
         } else if (key==='imdb') {
            arr.sort((a,b)=>(imdbIndex.get(a.id)??1e9) - (imdbIndex.get(b.id)??1e9));
         } else {
            // simple client sort
            const dir = key.endsWith('_desc')?-1:1;
            const f = key.startsWith('date') ? 'releaseDate' : (key.startsWith('rating')?'imdbRating':'name');
            arr.sort((a,b)=>{
               const va=a[f]||(f==='releaseDate'?a.year:null), vb=b[f]||(f==='releaseDate'?b.year:null);
               if(va==vb) return 0; if(!va) return 1; if(!vb) return -1;
               return (va<vb?-1:1)*dir;
            });
         }
         return arr;
      }

      // Init Grid
      const activeSort = (prefs.perListSort?.[lsid]) || 'name_asc';
      renderGrid(getSorted(activeSort));

      async function refreshDrawer() {
         const r = await getListItems(lsid); items = r.items;
         const cur = document.querySelector(`tr[data-lsid="${lsid}"] select`).value;
         renderGrid(getSorted(cur));
      }

      saveOrderBtn.onclick = async () => {
         const ids = Array.from(ul.querySelectorAll('li[data-id]')).map(l=>l.dataset.id);
         saveOrderBtn.innerText = 'Saving...';
         try { 
            await saveCustomOrder(lsid, ids);
            saveOrderBtn.innerText = 'Saved ✓'; setTimeout(()=>saveOrderBtn.innerText='Save Custom Order', 2000);
            // Auto set select to custom
            const sel = document.querySelector(`tr[data-lsid="${lsid}"] select`);
            if(sel) { sel.value='custom'; sel.dispatchEvent(new Event('change')); }
         } catch(e) { alert('Error'); saveOrderBtn.innerText='Error'; }
      };

      resetOrderBtn.onclick = () => {
         const cur = document.querySelector(`tr[data-lsid="${lsid}"] select`).value;
         renderGrid(getSorted(cur));
      };
      
      resetAllBtn.onclick = async () => {
        if(!confirm('Reset custom order and all added/removed items?')) return;
        await fetch('/api/list-reset?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid })});
        refreshDrawer();
      };

    }).catch(e => td.innerHTML = '<div class="text-red-500 p-4">Failed to load items</div>');

    return tr;
  }

  order.forEach(lsid => tbody.appendChild(makeRow(lsid)));
  attachDnD(tbody, 'tr', () => saveAll('Reordered lists'));
  
  // Save All Logic
  async function saveAll(msgText) {
    const newOrder = Array.from(tbody.querySelectorAll('tr[data-lsid]')).map(tr => tr.dataset.lsid);
    const enabled = Array.from(enabledSet);
    const body = {
      enabled, order: newOrder, defaultList: prefs.defaultList || enabled[0] || "",
      perListSort: prefs.perListSort, sortOptions: prefs.sortOptions, posterShapes: prefs.posterShapes,
      upgradeEpisodes: prefs.upgradeEpisodes, sources: prefs.sources, blocked: prefs.blocked, customOrder: prefs.customOrder
    };
    const msg = document.getElementById('saveMsg');
    msg.className = "text-center text-indigo-400 text-sm font-medium mt-2 h-6";
    msg.innerText = "Saving...";
    try {
       await fetch('/api/prefs?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
       msg.className = "text-center text-green-400 text-sm font-medium mt-2 h-6";
       msg.innerText = msgText || "All changes saved successfully.";
       setTimeout(()=>msg.innerText='', 3000);
    } catch(e) { 
       msg.className = "text-center text-red-400 text-sm font-medium mt-2 h-6";
       msg.innerText = "Save failed!"; 
    }
  }
  document.getElementById('saveBtn').onclick = () => saveAll();
}

wireAddButtons();
render();
</script>
</body></html>`);
});

// ----------------- BOOT -----------------
(async () => {
  try {
    const snap = await loadSnapshot();
    if (snap) {
      LISTS = snap.lists || LISTS;
      PREFS = { ...PREFS, ...(snap.prefs || {}) };
      FALLBK.clear(); if (snap.fallback) for (const [k,v] of Object.entries(snap.fallback)) FALLBK.set(k, v);
      CARD.clear();   if (snap.cards)    for (const [k,v] of Object.entries(snap.cards))    CARD.set(k, v);
      EP2SER.clear(); if (snap.ep2ser)   for (const [k,v] of Object.entries(snap.ep2ser))   EP2SER.set(k, v);
      MANIFEST_REV = snap.manifestRev || MANIFEST_REV;
      LAST_SYNC_AT = snap.lastSyncAt || 0;
      LAST_MANIFEST_KEY = manifestKey();
      console.log("[BOOT] snapshot loaded");
    }
  } catch(e){ console.warn("[BOOT] load snapshot failed:", e.message); }

  fullSync({ rediscover: true }).then(()=> scheduleNextSync()).catch(e => {
    console.warn("[BOOT] background sync failed:", e.message);
  });

  app.listen(PORT, HOST, () => {
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
  });
})();
