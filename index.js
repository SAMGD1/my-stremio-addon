/*  My Lists – IMDb → Stremio (custom per-list ordering, IMDb date order, sources & UI)
 *  v12.4.0
 */
"use strict";
const express = require("express");
const fs = require("fs/promises");

/* ----------------- ENV ----------------- */
const PORT  = Number(process.env.PORT || 7000);
const HOST  = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

const IMDB_USER_URL_RAW  = process.env.IMDB_USER_URL || ""; // e.g. https://www.imdb.com/user/urXXXXXXX/lists/
const IMDB_SYNC_MINUTES  = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));
const UPGRADE_EPISODES   = String(process.env.UPGRADE_EPISODES || "true").toLowerCase() !== "false";
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

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/12.4.0";
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};
const CINEMETA = "https://v3-cinemeta.strem.io";

/* ----------------- HELPERS ----------------- */
function normalizeUserListsUrl(u) {
  if (!u) return "";
  const m = String(u).match(/ur\d{6,}/i);
  if (!m) return "";
  return `https://www.imdb.com/user/${m[0]}/lists/`;
}
const IMDB_USER_URL = normalizeUserListsUrl(IMDB_USER_URL_RAW);

const isImdb   = v => /^tt\d{7,}$/i.test(String(v||""));
const isListId = v => /^ls\d{6,}$/i.test(String(v||""));
const minutes  = ms => Math.round(ms/60000);
const sleep    = ms => new Promise(r => setTimeout(r, ms));
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

/* ----------------- STATE ----------------- */
/** LISTS = { [lsid]: { id, name, url, ids:[tt...], orders:{ imdb:[], date_asc:[], date_desc:[] } } } */
let LISTS = Object.create(null);

/** PREFS saved to snapshot */
let PREFS = {
  listEdits: {},          // { [lsid]: { added: ["tt..."], removed: ["tt..."] } }
  enabled: [],            // lsids shown in Stremio
  order: [],              // lsids order in manifest
  defaultList: "",
  perListSort: {},        // { lsid: 'date_asc' | ... | 'custom' }
  sortOptions: {},        // { lsid: ['custom', 'date_desc', ...] }
  customOrder: {},        // { lsid: [ 'tt...', 'tt...' ] }
  upgradeEpisodes: UPGRADE_EPISODES,
  sources: { users: [], lists: [] },  // extra sources you add in the UI
  blocked: [],            // lsids you removed/blocked
  sourceKey: ""           // computed fingerprint of sources+blocked+main user
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

/* ----------------- SNAPSHOT (GH optional) ----------------- */
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
  // GitHub (if enabled) – with one retry on 409
  if (!GH_ENABLED) return;
  const path = "data/snapshot.json";
  const content = Buffer.from(JSON.stringify(obj, null, 2)).toString("base64");

  async function put(sha) {
    const body = { message: "Update snapshot.json", content, branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    return gh("PUT", `/contents/${encodeURIComponent(path)}`, body);
  }
  try {
    const sha = await ghGetSha(path);
    await put(sha);
  } catch (e) {
    if (String(e).includes("409")) {
      // refetch sha and retry once
      const sha2 = await ghGetSha(path);
      await put(sha2);
    } else {
      throw e;
    }
  }
}
async function loadSnapshot() {
  if (GH_ENABLED) {
    try {
      const data = await gh("GET", `/contents/${encodeURIComponent("data/snapshot.json")}?ref=${encodeURIComponent(GITHUB_BRANCH)}`);
      const buf = Buffer.from(data.content, "base64").toString("utf8");
      return JSON.parse(buf);
    } catch {/* ignore */}
  }
  try {
    const txt = await fs.readFile(SNAP_LOCAL, "utf8");
    return JSON.parse(txt);
  } catch { return null; }
}

/* ----------------- IMDb SCRAPING ----------------- */
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
function nextPageUrl(html) {
  let m = html.match(/<a[^>]+rel=["']next["'][^>]+href=["']([^"']+)["']/i);
  if (!m) m = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*lister-page-next[^"']*["']/i);
  if (!m) m = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*data-testid=["']pagination-next-page-button["'][^>]*>/i);
  if (!m) return null;
  try { return new URL(m[1], "https://www.imdb.com").toString(); } catch { return null; }
}
async function fetchImdbListIdsAllPages(listUrl, maxPages = 80) {
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
async function fetchImdbOrder(listUrl, sortSpec, maxPages = 80) {
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

/* ----------------- METADATA ----------------- */
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
  return metas.slice().sort((a,b) => {
    const pa = pos.has(a.id) ? pos.get(a.id) : Number.MAX_SAFE_INTEGER;
    const pb = pos.has(b.id) ? pos.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return (a.name||"").localeCompare(b.name||"");
  });
}
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

/* ----------------- SYNC ----------------- */
const SORT_OPTIONS = [
  "custom","imdb","date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"
];
const VALID_SORT = new Set(SORT_OPTIONS);

function manifestKey() {
  const enabled = (PREFS.enabled && PREFS.enabled.length) ? PREFS.enabled : Object.keys(LISTS);
  const names = enabled.map(id => LISTS[id]?.name || id).sort().join("|");
  const perSort = JSON.stringify(PREFS.perListSort || {});
  const perOpts = JSON.stringify(PREFS.sortOptions || {});
  const custom = Object.keys(PREFS.customOrder || {}).length;
  const order = (PREFS.order || []).join(",");
  return `${enabled.join(",")}#${order}#${PREFS.defaultList}#${names}#${perSort}#${perOpts}#c${custom}`;
}
function sourcesKeyFrom(prefs) {
  const users = (prefs.sources?.users || []).map(normalizeUserListsUrl).filter(Boolean).sort();
  const lists = (prefs.sources?.lists || []).map(String).map(s=>s.trim()).filter(Boolean).sort();
  const blocked = (prefs.blocked || []).slice().sort();
  return JSON.stringify({ main: IMDB_USER_URL, users, lists, blocked });
}

async function harvestSources() {
  const discovered = [];
  if (IMDB_USER_URL) {
    try { discovered.push(...await discoverFromUserLists(IMDB_USER_URL)); } catch(e){ console.warn("[DISCOVER] main failed:", e.message); }
  }
  const users = Array.from(new Set((PREFS.sources?.users || []).map(normalizeUserListsUrl).filter(Boolean)));
  for (const u of users) {
    try { discovered.push(...await discoverFromUserLists(u)); }
    catch(e){ console.warn("[DISCOVER] user", u, "failed:", e.message); }
    await sleep(80);
  }
  const addlRaw = (PREFS.sources?.lists || []).concat(IMDB_LIST_IDS || []);
  for (const raw of addlRaw) {
    const norm = normalizeListIdOrUrl(raw);
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
    discovered.push({ id, url, name });
    await sleep(60);
  }
  const blocked = new Set(PREFS.blocked || []);
  const map = new Map();
  for (const d of discovered) if (!blocked.has(d.id)) map.set(d.id, d);
  return Array.from(map.values());
}

/** strict: if true, don't carry over old lists that aren't rediscovered */
async function fullSync({ rediscover = true, strict = false } = {}) {
  if (syncInProgress) return;
  syncInProgress = true;
  const started = Date.now();
  try {
    let discovered = [];
    if (rediscover) discovered = await harvestSources();

    // fallback to explicit IMDB_LIST_IDS env if nothing discovered
    if ((!discovered || !discovered.length) && IMDB_LIST_IDS.length) {
      discovered = IMDB_LIST_IDS.map(id => ({ id, name: id, url: `https://www.imdb.com/list/${id}/` }));
      console.log(`[DISCOVER] used IMDB_LIST_IDS fallback (${discovered.length})`);
    }

    const next = Object.create(null);
    const seen = new Set();

    for (const d of discovered) {
      next[d.id] = { id: d.id, name: d.name || d.id, url: d.url, ids: [], orders: {} };
      seen.add(d.id);
    }

    // Only carry-over previous lists when NOT strict (e.g., temporary IMDb errors)
    if (!strict) {
      const blocked = new Set(PREFS.blocked || []);
      for (const id of Object.keys(LISTS)) if (!seen.has(id) && !blocked.has(id)) next[id] = LISTS[id];
    }

    // pull items & IMDb date orders
    const uniques = new Set();
    for (const id of Object.keys(next)) {
      const url = next[id].url || `https://www.imdb.com/list/${id}/`;
      let raw = [];
      try { raw = await fetchImdbListIdsAllPages(url); } catch {}
      next[id].ids = raw.slice();
      raw.forEach(tt => uniques.add(tt));

      if (IMDB_FETCH_RELEASE_ORDERS) {
        try {
          const asc  = await fetchImdbOrder(url,  "release_date,asc");
          const desc = await fetchImdbOrder(url, "release_date,desc");
          next[id].orders = next[id].orders || {};
          next[id].orders.date_asc  = asc.slice();
          next[id].orders.date_desc = desc.slice();
          asc.forEach(tt => uniques.add(tt));
          desc.forEach(tt => uniques.add(tt));
        } catch (e) {
          console.warn("[SYNC] release_date sort fetch failed for", id, e.message);
        }
      }
      await sleep(60);
    }

    // episode → series upgrade (optional)
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
    for (const tt of idsToPreload) { await getBestMeta(tt); CARD.set(tt, cardFor(tt)); }

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

/* ----------------- SERVER ----------------- */
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

/* ------- Manifest ------- */
const baseManifest = {
  id: "org.mylists.snapshot",
  version: "12.4.0",
  name: "My Lists",
  description: "Your IMDb lists as catalogs (cached).",
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
    posterShape: "poster"
  }));
}
app.get("/manifest.json", (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();
    const version = `${baseManifest.version}-${MANIFEST_REV}`;
    res.json({ ...baseManifest, version, catalogs: catalogs(), configuration: `${absoluteBase(req)}/configure` });
  }catch(e){ console.error("manifest:", e); res.status(500).send("Internal Server Error");}
});

/* A small helper endpoint the “Configure” button can open. */
app.get("/configure", (req,res)=>{
  const base = absoluteBase(req);
  const dest = `${base}/admin?admin=${encodeURIComponent(ADMIN_PASSWORD)}`;
  res.type("html").send(`
  <!doctype html><meta charset="utf-8">
  <title>Configure – My Lists</title>
  <meta http-equiv="refresh" content="0; url='${dest}'">
  <style>body{font-family:system-ui; background:#0f0d1a; color:#f7f7fb; display:grid; place-items:center; height:100vh}
  a{color:#9aa0b4;}</style>
  <p>Opening admin… <a href="${dest}">continue</a></p>
  `);
});

/* ------- Catalog ------- */
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

    // apply per-list edits
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

/* ------- Meta ------- */
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

/* ------- Admin + API ------- */
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
    const prevSourceKey = PREFS.sourceKey || sourcesKeyFrom(PREFS);

    const body = req.body || {};
    PREFS.enabled         = Array.isArray(body.enabled) ? body.enabled.filter(isListId) : [];
    PREFS.order           = Array.isArray(body.order)   ? body.order.filter(isListId)   : [];
    PREFS.defaultList     = isListId(body.defaultList) ? body.defaultList : "";
    PREFS.perListSort     = body.perListSort && typeof body.perListSort === "object" ? body.perListSort : (PREFS.perListSort || {});
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

    const newSourceKey = sourcesKeyFrom(PREFS);
    const sourcesChanged = newSourceKey !== prevSourceKey;
    PREFS.sourceKey = newSourceKey;

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER)
    });

    // If sources changed, do a strict sync so old/orphan lists don't linger
    if (sourcesChanged) {
      await fullSync({ rediscover:true, strict:true });
      scheduleNextSync();
      return res.status(200).send("Saved (sources changed) — re-synced strictly.");
    }

    res.status(200).send("Saved. Manifest rev " + MANIFEST_REV);
  }catch(e){ console.error("prefs save error:", e); res.status(500).send("Failed to save"); }
});

app.post("/api/unblock-list", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid||"");
    if (!/^ls\d{6,}$/i.test(lsid)) return res.status(400).send("Invalid lsid");
    PREFS.blocked = (PREFS.blocked || []).filter(id => id !== lsid);
    // strict here to reflect unblocking immediately & remove any orphans
    await fullSync({ rediscover:true, strict:true });
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
    PREFS.sources.users = Array.from(new Set([ ...(PREFS.sources.users||[]), ...users ])).map(normalizeUserListsUrl);
    PREFS.sources.lists = Array.from(new Set([ ...(PREFS.sources.lists||[]), ...lists ]));
    PREFS.sourceKey = sourcesKeyFrom(PREFS);
    await fullSync({ rediscover:true, strict:true }); // strict to avoid dupes/orphans
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
    const strict = String(req.query.strict||"") === "1";
    await fullSync({ rediscover:true, strict });
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
    await fullSync({ rediscover:true, strict:true }); // STRICT
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

/* ------- Admin page ------- */
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
  :root{color-scheme:light; --bg:#0f0d1a; --card:#15122b; --muted:#9aa0b4; --text:#f7f7fb; --accent:#6c5ce7; --accent2:#8b7cf7; --border:#2a2650}
  body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:0;background:linear-gradient(180deg,#141126 0%,#0f0d1a 100%);color:var(--text)}
  .wrap{max-width:1100px;margin:24px auto;padding:0 16px}
  .hero{padding:20px 0 8px}
  h1{margin:0 0 4px;font-weight:700}
  .subtitle{color:var(--muted)}
  .grid{display:grid;gap:16px;grid-template-columns:1fr}
  @media(min-width:980px){ .grid{grid-template-columns:1fr 1fr} }
  .card{border:1px solid var(--border);border-radius:14px;padding:16px;background:var(--card);box-shadow:0 8px 24px rgba(0,0,0,.28)}
  button{padding:10px 16px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
  .btn2{background:var(--accent2)}
  small{color:var(--muted)}
  .code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#1c1837;color:#d6d3ff;padding:4px 6px;border-radius:6px}
  table{width:100%;border-collapse:collapse}
  th,td{padding:10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
  .muted{color:var(--muted)}
  .inline-note{font-size:12px;color:var(--muted);margin-left:8px}
  .rowtools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}
  .pill{display:inline-flex;align-items:center;gap:8px;background:#1c1837;border:1px solid var(--border);border-radius:999px;padding:6px 10px;color:#dcd8ff}
  .pill .x{cursor:pointer;color:#ffb4b4}
  input[type="text"]{background:#1c1837;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px;width:100%}
  .row{display:grid;gap:10px;grid-template-columns:1fr 100px}
  .mini{font-size:12px}
  a.link{color:#c3c8ff;text-decoration:none}
</style>
</head><body>
<div class="wrap">
  <div class="hero">
    <h1>My Lists – Admin</h1>
    <div class="subtitle">Last sync: ${lastSyncText}</div>
  </div>

  <div class="grid">
    <div class="card">
      <h3>Current Snapshot</h3>
      <ul>${rows}</ul>
      <div class="rowtools">
        <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}"><button class="btn2">Sync IMDb Lists Now</button></form>
        <form method="POST" action="/api/purge-sync?admin=${ADMIN_PASSWORD}" onsubmit="return confirm('Purge & re-sync everything?')"><button>🧹 Purge & Sync</button></form>
        <span class="inline-note">Auto-sync every <b>${IMDB_SYNC_MINUTES}</b> min.</span>
      </div>
      <h4>Manifest URL</h4>
      <p class="code" id="murl">${manifestUrl}</p>
      <div class="rowtools">
        <button id="installApp" class="btn2">Install in Stremio (App)</button>
        <a class="link" target="_blank" href="https://web.stremio.com/#/addons?addonUrl=${encodeURIComponent(manifestUrl)}">Open in Stremio Web</a>
      </div>
      <p class="mini muted">Version bumps automatically when catalogs change.</p>
    </div>

    <div class="card">
      <h3>Discovered & Sources</h3>
      <div style="margin-top:8px">
        <div class="mini muted">Blocked lists (won't re-add on sync):</div>
        <div id="blockedPills"></div>
      </div>

      <p class="mini muted">We merge your main user (+ extras) and explicit list URLs/IDs. Removing a list also blocks it so it won’t re-appear on the next sync.</p>

      <div class="row">
        <div><label>Add IMDb <b>User /lists</b> URL</label>
          <input id="userInput" placeholder="https://www.imdb.com/user/urXXXXXXX/lists/" />
        </div>
        <div><button id="addUser">Add</button></div>
      </div>
      <div class="row">
        <div><label>Add IMDb <b>List</b> URL or ID (ls…)</label>
          <input id="listInput" placeholder="https://www.imdb.com/list/ls123456789/ or ls123456789" />
        </div>
        <div><button id="addList">Add</button></div>
      </div>

      <div style="margin-top:10px">
        <div class="mini muted">Your extra users:</div>
        <div id="userPills">(loading)</div>
      </div>
      <div style="margin-top:8px">
        <div class="mini muted">Your extra lists:</div>
        <div id="listPills">(loading)</div>
      </div>

      <h4 style="margin-top:14px">Discovered</h4>
      <ul>${disc}</ul>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <h3>Customize (enable/disable, order, defaults)</h3>
    <p class="muted">Drag rows to change list order. Click ▾ on a list to open tools. (The extended poster-drag UI from earlier is still supported.)</p>
    <div id="prefs"></div>
  </div>

</div>

<script>
const ADMIN="${ADMIN_PASSWORD}";
const SORT_OPTIONS = ${JSON.stringify(SORT_OPTIONS)};

function el(tag, attrs={}, kids=[]){ const e=document.createElement(tag); for(const k in attrs){ if(k==='text') e.textContent=attrs[k]; else e.setAttribute(k,attrs[k]); } kids.forEach(c=>e.appendChild(c)); return e; }

async function getPrefs(){ const r = await fetch('/api/prefs?admin='+ADMIN); return r.json(); }
async function getLists(){ const r = await fetch('/api/lists?admin='+ADMIN); return r.json(); }

function normalizeUserListsUrl(v){
  v = String(v||'').trim();
  if (!v) return null;
  if (/imdb\\.com\\/user\\/ur\\d+\\/lists/i.test(v)) return v;
  const m = v.match(/ur\\d{6,}/i);
  return m ? 'https://www.imdb.com/user/'+m[0]+'/lists/' : null;
}
function normalizeListIdOrUrl2(v){
  v = String(v||'').trim();
  if (!v) return null;
  if (/imdb\\.com\\/list\\/ls\\d{6,}/i.test(v)) return v;
  const m = v.match(/ls\\d{6,}/i);
  return m ? 'https://www.imdb.com/list/'+m[0]+'/' : null;
}
async function addSources(payload){
  await fetch('/api/add-sources?admin='+ADMIN, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
}

function renderPills(id, arr, onRemove){
  const wrap = document.getElementById(id); wrap.innerHTML = '';
  (arr||[]).forEach((txt, idx)=>{
    const pill = el('span', {class:'pill'}, [ el('span',{text:txt}), el('span',{class:'x',text:'✕'}) ]);
    pill.querySelector('.x').onclick = ()=> onRemove(idx);
    wrap.appendChild(pill); wrap.appendChild(document.createTextNode(' '));
  });
  if (!arr || !arr.length) wrap.textContent = '(none)';
}

async function render() {
  const prefs = await getPrefs();
  const lists = await getLists();

  // Install button
  document.getElementById('installApp').onclick = ()=>{
    const m = document.getElementById('murl').textContent.trim();
    if (!confirm('Open the Stremio app to install this add-on?')) return;
    const deep = 'stremio://' + encodeURIComponent(m);
    const t = setTimeout(()=>{ window.open('https://web.stremio.com/#/addons?addonUrl='+encodeURIComponent(m),'_blank'); }, 1200);
    window.location.href = deep;
    setTimeout(()=> clearTimeout(t), 4000);
  };

  renderPills('userPills', prefs.sources?.users || [], (i)=>{
    prefs.sources.users.splice(i,1);
    saveAll(prefs, lists, 'Saved');
  });
  renderPills('listPills', prefs.sources?.lists || [], (i)=>{
    prefs.sources.lists.splice(i,1);
    saveAll(prefs, lists, 'Saved');
  });

  // Blocked pills with Unblock action
  {
    const blockedWrap = el('div', {});
    const target = document.getElementById('blockedPills'); target.innerHTML='';
    const blocked = prefs.blocked || [];
    if (!blocked.length) blockedWrap.textContent='(none)';
    blocked.forEach(lsid=>{
      const pill = el('span',{class:'pill'},[ el('span',{text:lsid}), el('span',{class:'x',text:' Unblock'}) ]);
      pill.querySelector('.x').onclick = async ()=>{
        await fetch('/api/unblock-list?admin='+ADMIN, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid }) });
        location.reload();
      };
      blockedWrap.appendChild(pill); blockedWrap.appendChild(document.createTextNode(' '));
    });
    target.appendChild(blockedWrap);
  }

  // Basic table (keeps your previous features)
  const container = document.getElementById('prefs'); container.innerHTML = "";
  const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));
  const baseOrder = (prefs.order && prefs.order.length ? prefs.order.filter(id => lists[id]) : []);
  const missing   = Object.keys(lists).filter(id => !baseOrder.includes(id))
    .sort((a,b)=>( (lists[a]?.name||a).localeCompare(lists[b]?.name||b) ));
  const order = baseOrder.concat(missing);

  const table = el('table');
  const thead = el('thead', {}, [el('tr',{},[
    el('th',{text:''}), el('th',{text:'Enabled'}), el('th',{text:'List (lsid)'}), el('th',{text:'Items'}),
    el('th',{text:'Default sort'}), el('th',{text:'Remove'})
  ])]);
  table.appendChild(thead);
  const tbody = el('tbody');

  function makeRow(lsid) {
    const L = lists[lsid];
    const tr = el('tr', {'data-lsid': lsid});
    tr.appendChild(el('td',{text:'▾'})); // simplified toggle (kept minimal)
    const cb = el('input', {type:'checkbox'}); cb.checked = enabledSet.has(lsid);
    cb.onchange=()=>{ if(cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); };
    tr.appendChild(el('td',{},[cb]));
    const nameCell = el('td',{}); nameCell.appendChild(el('div',{text:(L.name||lsid)})); nameCell.appendChild(el('small',{text:lsid}));
    tr.appendChild(nameCell);
    tr.appendChild(el('td',{text:String((L.ids||[]).length)}));
    const sel = el('select'); SORT_OPTIONS.forEach(o=>{ const op=el('option',{value:o,text:o}); if((prefs.perListSort?.[lsid]||'name_asc')===o) op.setAttribute('selected',''); sel.appendChild(op); });
    sel.onchange=()=>{ prefs.perListSort = prefs.perListSort || {}; prefs.perListSort[lsid] = sel.value; };
    tr.appendChild(el('td',{},[sel]));
    const rm = el('button',{text:'Remove'}); rm.onclick=()=> removeList(lsid);
    tr.appendChild(el('td',{},[rm]));
    return tr;
  }
  function removeList(lsid){
    if (!confirm('Remove this list and block it from reappearing?')) return;
    fetch('/api/remove-list?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid })})
      .then(()=> location.reload())
      .catch(()=> alert('Remove failed'));
  }
  order.forEach(lsid => tbody.appendChild(makeRow(lsid)));
  table.appendChild(tbody);
  container.appendChild(table);

  const saveWrap = el('div',{class:'rowtools'});
  const saveBtn = el('button',{text:'Save'});
  const msg = el('span',{class:'inline-note'});
  saveWrap.appendChild(saveBtn); saveWrap.appendChild(msg);
  container.appendChild(saveWrap);

  async function saveAll(prefsNow, listsNow, text){
    const newOrder = Array.from(tbody.querySelectorAll('tr[data-lsid]')).map(tr => tr.getAttribute('data-lsid'));
    const enabled = Array.from(enabledSet);
    const body = {
      enabled,
      order: newOrder,
      defaultList: prefsNow.defaultList || (enabled[0] || ""),
      perListSort: prefsNow.perListSort || {},
      sortOptions: prefsNow.sortOptions || {},
      upgradeEpisodes: prefsNow.upgradeEpisodes || false,
      sources: prefsNow.sources || {},
      blocked: prefsNow.blocked || []
    };
    msg.textContent = "Saving…";
    const r = await fetch('/api/prefs?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    const t = await r.text();
    msg.textContent = text || t || "Saved.";
    setTimeout(()=>{ msg.textContent = ""; }, 1800);
    if (!r.ok) alert('Save failed');
  }
  saveBtn.onclick = ()=> saveAll(prefs, lists);
}

document.getElementById('addUser').onclick = async (e)=>{ e.preventDefault(); const url=normalizeUserListsUrl(document.getElementById('userInput').value); if(!url) return alert('Enter a valid IMDb user /lists URL or ur… id'); await addSources({users:[url],lists:[]}); location.reload(); };
document.getElementById('addList').onclick = async (e)=>{ e.preventDefault(); const url=normalizeListIdOrUrl2(document.getElementById('listInput').value); if(!url) return alert('Enter a valid IMDb list URL or ls… id'); await addSources({users:[],lists:[url]}); location.reload(); };

render();
</script>
</body></html>`);
});

/* ----------------- BOOT ----------------- */
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
      if (!PREFS.sourceKey) PREFS.sourceKey = sourcesKeyFrom(PREFS);
      console.log("[BOOT] snapshot loaded");
    }
  } catch(e){ console.warn("[BOOT] load snapshot failed:", e.message); }

  // First run: strict to avoid stale carry-over if sources changed since last deploy
  fullSync({ rediscover: true, strict: true }).then(()=> scheduleNextSync()).catch(e => {
    console.warn("[BOOT] background sync failed:", e.message);
  });

  app.listen(PORT, HOST, () => {
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
  });
})();
