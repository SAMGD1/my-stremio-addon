/*  My Lists – IMDb → Stremio (custom per-list ordering, IMDb date order, sources & UI)
 *  v12.4.3 – Trakt user-lists + global lists + IMDb chart/search pages + UI tabs + row drag + up/down buttons
 */
"use strict";
const express = require("express");
const fs = require("fs/promises");

// --- fetch polyfill (works on Node 16/18/20) ---
let _fetch = global.fetch;
if (!_fetch) {
  _fetch = (...args) =>
    import("node-fetch").then(({ default: f }) => f(...args));
}
const fetch = (...args) => _fetch(...args);

// ----------------- ENV -----------------
const PORT = Number(process.env.PORT || 7000);
const HOST = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET = process.env.SHARED_SECRET || "";

const IMDB_USER_URL = process.env.IMDB_USER_URL || ""; // https://www.imdb.com/user/urXXXXXXX/lists/
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));
const UPGRADE_EPISODES =
  String(process.env.UPGRADE_EPISODES || "true").toLowerCase() !== "false";

// fetch IMDb’s own release-date page order so our date sort matches IMDb exactly
const IMDB_FETCH_RELEASE_ORDERS =
  String(process.env.IMDB_FETCH_RELEASE_ORDERS || "true").toLowerCase() !==
  "false";

// Optional fallback: comma-separated ls ids
const IMDB_LIST_IDS = (process.env.IMDB_LIST_IDS || "")
  .split(/[,\s]+/)
  .map((s) => s.trim())
  .filter((s) => /^ls\d{6,}$/i.test(s));

// Optional GitHub snapshot persistence
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GH_ENABLED = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);
const SNAP_LOCAL = "data/snapshot.json";

// NEW: Trakt support (public API key / client id)
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID || "";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/12.4.3";
const REQ_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};
const CINEMETA = "https://v3-cinemeta.strem.io";

// include "imdb" (raw list order) and mirror IMDb’s release-date order when available
const SORT_OPTIONS = [
  "custom",
  "imdb",
  "date_asc",
  "date_desc",
  "rating_asc",
  "rating_desc",
  "runtime_asc",
  "runtime_desc",
  "name_asc",
  "name_desc",
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
  listEdits: {}, // { [listId]: { added: ["tt..."], removed: ["tt..."] } }
  enabled: [], // listIds shown in Stremio
  order: [], // listIds order in manifest
  defaultList: "",
  perListSort: {}, // { listId: 'date_asc' | ... | 'custom' }
  sortOptions: {}, // { listId: ['custom', 'date_desc', ...] }
  customOrder: {}, // { listId: [ 'tt...', 'tt...' ] }
  posterShape: {}, // kept for backwards-compat; not used any more
  upgradeEpisodes: UPGRADE_EPISODES,
  sources: {
    // extra sources you add in the UI
    users: [], // array of IMDb / Trakt user /lists URLs
    lists: [], // array of list URLs (IMDb or Trakt) or lsids
  },
  blocked: [], // listIds you removed/blocked (IMDb or Trakt)
};

const BEST = new Map(); // Map<tt, { kind, meta }>
const FALLBK = new Map(); // Map<tt, { name?, poster?, releaseDate?, year?, type? }>
const EP2SER = new Map(); // Map<episode_tt, parent_series_tt>
const CARD = new Map(); // Map<tt, card>

let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;

let MANIFEST_REV = 1;
let LAST_MANIFEST_KEY = "";

// ----------------- UTILS -----------------
const isImdb = (v) => /^tt\d{7,}$/i.test(String(v || ""));

const isImdbListId = (v) => /^ls\d{6,}$/i.test(String(v || ""));
const isImdbUrlId = (v) => /^imdburl:.+/i.test(String(v || ""));
const isTraktUserListId = (v) => /^trakt:[^:]+:[^:]+$/i.test(String(v || ""));
const isTraktGlobalListId = (v) => /^traktlist:.+$/i.test(String(v || ""));
const isTraktListId = (v) => isTraktUserListId(v) || isTraktGlobalListId(v);
const isListId = (v) => isImdbListId(v) || isImdbUrlId(v) || isTraktListId(v);

function makeTraktListKey(user, slug) {
  return `trakt:${user}:${slug}`;
}
function makeTraktGlobalListKey(id) {
  return `traktlist:${id}`;
}
function parseTraktListKey(id) {
  const m = String(id || "").match(/^trakt:([^:]+):(.+)$/i);
  return m ? { user: m[1], slug: m[2] } : null;
}
function parseTraktGlobalListKey(id) {
  const m = String(id || "").match(/^traktlist:(.+)$/i);
  return m ? { id: m[1] } : null;
}

const minutes = (ms) => Math.round(ms / 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clampSortOptions = (arr) =>
  Array.isArray(arr) ? arr.filter((x) => VALID_SORT.has(x)) : [];

async function fetchText(url) {
  const r = await fetch(url, { headers: REQ_HEADERS, redirect: "follow" });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    redirect: "follow",
  });
  if (!r.ok) return null;
  try {
    return await r.json();
  } catch {
    return null;
  }
}
const withParam = (u, k, v) => {
  const x = new URL(u);
  x.searchParams.set(k, v);
  return x.toString();
};

// ---- GitHub snapshot (optional) ----
async function gh(method, path, bodyObj) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`GitHub ${method} ${path} -> ${r.status}: ${t}`);
  }
  return r.json();
}
async function ghGetSha(path) {
  try {
    const data = await gh(
      "GET",
      `/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(
        GITHUB_BRANCH
      )}`
    );
    return (data && data.sha) || null;
  } catch {
    return null;
  }
}
async function saveSnapshot(obj) {
  // local (best effort)
  try {
    await fs.mkdir("data", { recursive: true });
    await fs.writeFile(SNAP_LOCAL, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    /* ignore */
  }
  // GitHub (if enabled)
  if (!GH_ENABLED) return;
  const content = Buffer.from(JSON.stringify(obj, null, 2)).toString("base64");
  const path = "data/snapshot.json";
  const sha = await ghGetSha(path);
  const body = {
    message: "Update snapshot.json",
    content,
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  await gh("PUT", `/contents/${encodeURIComponent(path)}`, body);
}
async function loadSnapshot() {
  // try GitHub first
  if (GH_ENABLED) {
    try {
      const data = await gh(
        "GET",
        `/contents/${encodeURIComponent(
          "data/snapshot.json"
        )}?ref=${encodeURIComponent(GITHUB_BRANCH)}`
      );
      const buf = Buffer.from(data.content, "base64").toString("utf8");
      return JSON.parse(buf);
    } catch {
      /* ignore */
    }
  }
  // local
  try {
    const txt = await fs.readFile(SNAP_LOCAL, "utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
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
  const id = decodeURIComponent(
    s.match(/trakt\.tv\/lists\/([^?#]+)/i)[1].replace(/\/+$/, "")
  );
  return { id };
}

async function traktJson(path) {
  if (!TRAKT_CLIENT_ID) throw new Error("TRAKT_CLIENT_ID not set");
  const url = `https://api.trakt.tv${path}`;
  const r = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": TRAKT_CLIENT_ID,
      "User-Agent": UA,
    },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`Trakt ${path} -> ${r.status}`);
  try {
    return await r.json();
  } catch {
    return null;
  }
}

async function fetchTraktListMeta(user, slug) {
  try {
    const data = await traktJson(
      `/users/${encodeURIComponent(user)}/lists/${encodeURIComponent(slug)}`
    );
    if (!data) return null;
    return {
      name: data.name || `${user}/${slug}`,
      url: `https://trakt.tv/users/${user}/lists/${slug}`,
    };
  } catch (e) {
    console.warn("[TRAKT] list meta failed", user, slug, e.message);
    return null;
  }
}

// NEW: global lists meta
async function fetchTraktGlobalListMeta(id) {
  try {
    const data = await traktJson(`/lists/${encodeURIComponent(id)}`);
    if (!data) return null;
    const name = data.name || id;
    return {
      name,
      url: `https://trakt.tv/lists/${id}`,
    };
  } catch (e) {
    console.warn("[TRAKT] global list meta failed", id, e.message);
    return null;
  }
}

async function fetchTraktListImdbIds(user, slug) {
  const types = [
    { key: "movies", prop: "movie" },
    { key: "shows", prop: "show" },
    { key: "episodes", prop: "episode" },
  ];
  const out = [];
  const seen = new Set();

  for (const { key, prop } of types) {
    let page = 1;
    while (true) {
      let items;
      try {
        items = await traktJson(
          `/users/${encodeURIComponent(
            user
          )}/lists/${encodeURIComponent(
            slug
          )}/items/${key}?page=${page}&limit=100`
        );
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

// NEW: global lists items
async function fetchTraktGlobalListImdbIds(id) {
  const types = [
    { key: "movies", prop: "movie" },
    { key: "shows", prop: "show" },
    { key: "episodes", prop: "episode" },
  ];
  const out = [];
  const seen = new Set();

  for (const { key, prop } of types) {
    let page = 1;
    while (true) {
      let items;
      try {
        items = await traktJson(
          `/lists/${encodeURIComponent(id)}/items/${key}?page=${page}&limit=100`
        );
      } catch (e) {
        console.warn("[TRAKT] global items fetch failed", id, key, e.message);
        break;
      }
      if (!Array.isArray(items) || !items.length) break;

      for (const it of items) {
        const obj = it[prop];
        const ids = obj && obj.ids;
        let imdb = ids && ids.imdb;

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
    arr = await traktJson(`/users/${encodeURIComponent(user)}/lists`);
  } catch (e) {
    console.warn("[TRAKT] discoverTraktUserLists failed", user, e.message);
    return [];
  }
  if (!Array.isArray(arr)) return [];

  return arr.map((l) => {
    const slug =
      (l.ids && l.ids.slug) || l.slug || String((l.ids && l.ids.trakt) || "");
    const id = makeTraktListKey(user, slug || `list-${Date.now()}`);
    return {
      id,
      url: `https://trakt.tv/users/${user}/lists/${slug}`,
      name: l.name || `${user}/${slug}`,
    };
  });
}

// ----------------- IMDb DISCOVERY -----------------
function normalizeListIdOrUrl(s) {
  if (!s) return null;
  s = String(s).trim();

  // classic IMDb list id
  const m = s.match(/ls\d{6,}/i);
  if (m) return { id: m[0], url: `https://www.imdb.com/list/${m[0]}/` };

  // explicit list URL
  if (/imdb\.com\/list\//i.test(s)) return { id: null, url: s };

  // NEW: treat chart/search pages as "lists"
  if (/imdb\.com\/(chart|search)\//i.test(s)) {
    const url = s.startsWith("http") ? s : `https://www.imdb.com${s}`;
    const enc = encodeURIComponent(url);
    return { id: `imdburl:${enc}`, url };
  }

  return null;
}

async function discoverFromUserLists(userListsUrl) {
  if (!userListsUrl) return [];
  const html = await fetchText(withParam(userListsUrl, "_", Date.now()));
  const re =
    /href=['"](?:https?:\/\/(?:www\.)?imdb\.com)?\/list\/(ls\d{6,})\/['"]/gi;
  const ids = new Set();
  let m;
  while ((m = re.exec(html))) ids.add(m[1]);
  if (!ids.size) {
    const re2 = /\/list\/(ls\d{6,})\//gi;
    while ((m = re2.exec(html))) ids.add(m[1]);
  }
  const arr = Array.from(ids).map((id) => ({
    id,
    url: `https://www.imdb.com/list/${id}/`,
  }));
  await Promise.all(
    arr.map(async (L) => {
      try {
        L.name = await fetchListName(L.url);
      } catch {
        L.name = L.id;
      }
    })
  );
  return arr;
}
async function fetchListName(listUrl) {
  const html = await fetchText(withParam(listUrl, "_", Date.now()));
  const tries = [
    /<h1[^>]+data-testid=["']list-header-title["'][^>]*>(.*?)<\/h1>/i,
    /<h1[^>]*class=["'][^"']*header[^"']*["'][^>]*>(.*?)<\/h1>/i,
  ];
  for (const rx of tries) {
    const m = html.match(rx);
    if (m)
      return m[1]
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
  }
  const t = html.match(/<title>(.*?)<\/title>/i);
  return t
    ? t[1]
        .replace(/\s+\-\s*IMDb.*$/i, "")
        .trim()
    : listUrl;
}
function tconstsFromHtml(html) {
  const out = [];
  const seen = new Set();
  let m;
  const re1 = /data-tconst=["'](tt\d{7,})["']/gi;
  while ((m = re1.exec(html)))
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  const re2 = /\/title\/(tt\d{7,})\//gi;
  while ((m = re2.exec(html)))
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  return out;
}
function nextPageUrl(html) {
  let m = html.match(
    /<a[^>]+rel=["']next["'][^>]+href=["']([^"']+)["']/i
  );
  if (!m)
    m = html.match(
      /<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*lister-page-next[^"']*["']/i
    );
  if (!m)
    m = html.match(
      /<a[^>]+href=["']([^"']+)["'][^>]*data-testid=["']pagination-next-page-button["'][^>]*>/i
    );
  if (!m) return null;
  try {
    return new URL(m[1], "https://www.imdb.com").toString();
  } catch {
    return null;
  }
}
async function fetchImdbListIdsAllPages(listUrl, maxPages = 80) {
  // raw order (whatever the list currently displays by default)
  const seen = new Set();
  const ids = [];
  let url = withParam(listUrl, "mode", "detail");
  let pages = 0;
  while (url && pages < maxPages) {
    let html;
    try {
      html = await fetchText(withParam(url, "_", Date.now()));
    } catch {
      break;
    }
    const found = tconstsFromHtml(html);
    let added = 0;
    for (const tt of found)
      if (!seen.has(tt)) {
        seen.add(tt);
        ids.push(tt);
        added++;
      }
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
  const seen = new Set();
  const ids = [];
  let url = withParam(withParam(listUrl, "mode", "detail"), "sort", sortSpec);
  let pages = 0;
  while (url && pages < maxPages) {
    let html;
    try {
      html = await fetchText(withParam(url, "_", Date.now()));
    } catch {
      break;
    }
    const found = tconstsFromHtml(html);
    for (const tt of found)
      if (!seen.has(tt)) {
        seen.add(tt);
        ids.push(tt);
      }
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
    const j = await fetchJson(`${CINEMETA}/meta/${kind}/${imdbId}.json`);
    return j && j.meta ? j.meta : null;
  } catch {
    return null;
  }
}
async function imdbJsonLd(imdbId) {
  try {
    const html = await fetchText(`https://www.imdb.com/title/${imdbId}/`);
    const m = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i
    );
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        /* ignore */
      }
    }
    const t = html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
    );
    const p = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    );
    return { name: t ? t[1] : undefined, image: p ? p[1] : undefined };
  } catch {
    return null;
  }
}
async function episodeParentSeries(imdbId) {
  if (EP2SER.has(imdbId)) return EP2SER.get(imdbId);
  const ld = await imdbJsonLd(imdbId);
  let seriesId = null;
  try {
    const node = Array.isArray(ld && ld["@graph"])
      ? ld["@graph"].find((x) => /TVEpisode/i.test(x["@type"])) ||
        ld["@graph"][0]
      : ld;
    const part =
      node &&
      (node.partOfSeries ||
        node.partOfTVSeries ||
        (node.partOfSeason && node.partOfSeason.partOfSeries));
    const url =
      typeof part === "string"
        ? part
        : part && (part.url || part.sameAs || part["@id"]);
    if (url) {
      const m = String(url).match(/tt\d{7,}/i);
      if (m) seriesId = m[0];
    }
  } catch {
    /* ignore */
  }
  if (seriesId) EP2SER.set(imdbId, seriesId);
  return seriesId;
}
async function getBestMeta(imdbId) {
  if (BEST.has(imdbId)) return BEST.get(imdbId);
  let meta = await fetchCinemeta("series", imdbId);
  if (meta) {
    const rec = { kind: "series", meta };
    BEST.set(imdbId, rec);
    return rec;
  }
  meta = await fetchCinemeta("movie", imdbId);
  if (meta) {
    const rec = { kind: "movie", meta };
    BEST.set(imdbId, rec);
    return rec;
  }
  const ld = await imdbJsonLd(imdbId);
  let name,
    poster,
    background,
    released,
    year,
    type = "movie";
  try {
    const node = Array.isArray(ld && ld["@graph"])
      ? ld["@graph"].find((x) => x["@id"]?.includes(`/title/${imdbId}`)) ||
        ld["@graph"][0]
      : ld;
    name = node?.name || node?.headline || ld?.name;
    poster =
      typeof node?.image === "string"
        ? node.image
        : node?.image?.url || ld?.image;
    background = poster;
    released =
      node?.datePublished || node?.startDate || node?.releaseDate || undefined;
    year = released ? Number(String(released).slice(0, 4)) : undefined;
    const t = Array.isArray(node?.["@type"])
      ? node["@type"].join(",")
      : node?.["@type"] || "";
    if (/Series/i.test(t)) type = "series";
    else if (/TVEpisode/i.test(t)) type = "episode";
  } catch {
    /* ignore */
  }
  const rec = {
    kind: type === "series" ? "series" : "movie",
    meta: name
      ? { name, poster, background, released, year }
      : null,
  };
  BEST.set(imdbId, rec);
  if (name || poster)
    FALLBK.set(imdbId, {
      name,
      poster,
      releaseDate: released,
      year,
      type: rec.kind,
    });
  return rec;
}

// central place to build a "card" for admin + catalogs
function cardFor(imdbId) {
  const rec = BEST.get(imdbId) || { kind: null, meta: null };
  const m = rec.meta || {};
  const fb = FALLBK.get(imdbId) || {};

  const portrait = m.poster || fb.poster;
  const landscape = m.background || portrait || fb.poster;

  return {
    id: imdbId,
    type: rec.kind || fb.type || "movie",
    name: m.name || fb.name || imdbId,
    poster: portrait || landscape || undefined,
    posterPortrait: portrait || landscape || undefined,
    posterLandscape: landscape || portrait || undefined,
    background: m.background || undefined,
    imdbRating: m.imdbRating ?? undefined,
    runtime: m.runtime ?? undefined,
    year: m.year ?? fb.year ?? undefined,
    releaseDate: m.released || fb.releaseDate || undefined,
    description: m.description || undefined,
  };
}

function toTs(d, y) {
  if (d) {
    const t = Date.parse(d);
    if (!Number.isNaN(t)) return t;
  }
  if (y) {
    const t = Date.parse(`${y}-01-01`);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}
function stableSort(items, sortKey) {
  const s = String(sortKey || "name_asc").toLowerCase();
  const dir = s.endsWith("_asc") ? 1 : -1;
  const key = s.split("_")[0];
  const cmpNullBottom = (a, b) =>
    a == null && b == null
      ? 0
      : a == null
      ? 1
      : b == null
      ? -1
      : a < b
      ? -1
      : a > b
      ? 1
      : 0;
  return items
    .map((m, i) => ({ m, i }))
    .sort((A, B) => {
      const a = A.m,
        b = B.m;
      let c = 0;
      if (key === "date")
        c = cmpNullBottom(toTs(a.releaseDate, a.year), toTs(b.releaseDate, b.year));
      else if (key === "rating")
        c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
      else if (key === "runtime")
        c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
      else c = (a.name || "").localeCompare(b.name || "");
      if (c === 0) {
        c = (a.name || "").localeCompare(b.name || "");
        if (c === 0) c = (a.id || "").localeCompare(b.id || "");
        if (c === 0) c = A.i - B.i;
      }
      return c * dir;
    })
    .map((x) => x.m);
}
function applyCustomOrder(metas, lsid) {
  const order = (PREFS.customOrder && PREFS.customOrder[lsid]) || [];
  if (!order || !order.length) return metas.slice();
  const pos = new Map(order.map((id, i) => [id, i]));
  return metas.slice().sort((a, b) => {
    const pa = pos.has(a.id) ? pos.get(a.id) : Number.MAX_SAFE_INTEGER;
    const pb = pos.has(b.id) ? pos.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return (a.name || "").localeCompare(b.name || "");
  });
}
// order helper (imdb/date_asc/date_desc) backed by LISTS[lsid].orders
function sortByOrderKey(metas, lsid, key) {
  const list = LISTS[lsid];
  if (!list) return metas.slice();
  const arr =
    list.orders && Array.isArray(list.orders[key]) && list.orders[key].length
      ? list.orders[key]
      : key === "imdb"
      ? list.ids || []
      : null;
  if (!arr) return metas.slice();
  const pos = new Map(arr.map((id, i) => [id, i]));
  return metas.slice().sort(
    (a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9)
  );
}

// ----------------- SYNC -----------------
function manifestKey() {
  const enabled =
    PREFS.enabled && PREFS.enabled.length ? PREFS.enabled : Object.keys(LISTS);
  const names = enabled
    .map((id) => LISTS[id]?.name || id)
    .sort()
    .join("|");
  const perSort = JSON.stringify(PREFS.perListSort || {});
  const perOpts = JSON.stringify(PREFS.sortOptions || {});
  const custom = Object.keys(PREFS.customOrder || {}).length;
  const shapes = JSON.stringify(PREFS.posterShape || {});
  const order = (PREFS.order || []).join(",");

  return `${enabled.join(",")}#${order}#${PREFS.defaultList}#${names}#${perSort}#${perOpts}#c${custom}#sh${shapes}`;
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
    new Set(
      (PREFS.sources?.users || [])
        .map((s) => String(s).trim())
        .filter(Boolean)
    )
  );
  for (const u of users) {
    try {
      if (/trakt\.tv/i.test(u)) {
        // Trakt user lists
        const arr = await discoverTraktUserLists(u);
        arr.forEach(add);
      } else {
        // IMDb user lists
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

    // ---- Trakt user lists ----
    const tinfo = parseTraktListUrl(val);
    if (tinfo) {
      if (!TRAKT_CLIENT_ID) {
        console.warn(
          "[TRAKT] got user list",
          val,
          "but TRAKT_CLIENT_ID is not set – ignoring."
        );
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
            url: `https://trakt.tv/users/${tinfo.user}/lists/${tinfo.slug}`,
            name,
          });
        }
      }
      await sleep(60);
      continue;
    }

    // ---- Trakt global / official lists ----
    const ginfo = parseTraktGlobalListUrl(val);
    if (ginfo) {
      if (!TRAKT_CLIENT_ID) {
        console.warn(
          "[TRAKT] got global list",
          val,
          "but TRAKT_CLIENT_ID is not set – ignoring."
        );
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
            url: `https://trakt.tv/lists/${ginfo.id}`,
            name,
          });
        }
      }
      await sleep(60);
      continue;
    }

    // ---- IMDb lists / charts / searches ----
    const norm = normalizeListIdOrUrl(val);
    if (!norm) continue;
    let { id, url } = norm;
    if (!id) {
      const m2 = String(url).match(/ls\d{6,}/i);
      if (m2) id = m2[0];
    }
    if (!id) continue;

    let name = id;
    try {
      name = await fetchListName(url);
    } catch {
      /* ignore */
    }

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
      discovered = IMDB_LIST_IDS.map((id) => ({
        id,
        name: id,
        url: `https://www.imdb.com/list/${id}/`,
      }));
      console.log(
        `[DISCOVER] used IMDB_LIST_IDS fallback (${discovered.length})`
      );
    }

    const next = Object.create(null);
    const seen = new Set();
    for (const d of discovered) {
      next[d.id] = {
        id: d.id,
        name: d.name || d.id,
        url: d.url,
        ids: [],
        orders: d.orders || {},
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
        if (!TRAKT_CLIENT_ID) {
          console.warn(
            "[SYNC] Trakt list present but TRAKT_CLIENT_ID missing",
            id
          );
        } else if (isTraktUserListId(id)) {
          const ts = parseTraktListKey(id);
          if (ts) {
            try {
              raw = await fetchTraktListImdbIds(ts.user, ts.slug);
            } catch (e) {
              console.warn(
                "[SYNC] Trakt user list fetch failed for",
                id,
                e.message
              );
            }
          }
        } else if (isTraktGlobalListId(id)) {
          const gl = parseTraktGlobalListKey(id);
          if (gl) {
            try {
              raw = await fetchTraktGlobalListImdbIds(gl.id);
            } catch (e) {
              console.warn(
                "[SYNC] Trakt global list fetch failed for",
                id,
                e.message
              );
            }
          }
        }
      } else {
        const url =
          list.url ||
          (isImdbUrlId(id)
            ? decodeURIComponent(id.slice("imdburl:".length))
            : `https://www.imdb.com/list/${id}/`);
        try {
          raw = await fetchImdbListIdsAllPages(url);
        } catch (e) {
          console.warn("[SYNC] IMDb list fetch failed for", id, e.message);
        }

        if (IMDB_FETCH_RELEASE_ORDERS && isImdbListId(id)) {
          try {
            const asc = await fetchImdbOrder(url, "release_date,asc");
            const desc = await fetchImdbOrder(url, "release_date,desc");
            list.orders = list.orders || {};
            list.orders.date_asc = asc.slice();
            list.orders.date_desc = desc.slice();
            asc.forEach((tt) => uniques.add(tt));
            desc.forEach((tt) => uniques.add(tt));
          } catch (e) {
            console.warn(
              "[SYNC] release_date sort fetch failed for",
              id,
              e.message
            );
          }
        }
      }

      list.ids = raw.slice();
      raw.forEach((tt) => uniques.add(tt));
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
        const out = [];
        const S = new Set();
        for (const tt of arr) {
          let fin = tt;
          const r = BEST.get(tt);
          if (!r || !r.meta) {
            const z = EP2SER.get(tt);
            if (z) fin = z;
          }
          if (!S.has(fin)) {
            S.add(fin);
            out.push(fin);
          }
        }
        return out;
      };

      for (const id of Object.keys(next)) {
        next[id].ids = remap(next[id].ids);
        next[id].orders = next[id].orders || {};
        if (next[id].orders.date_asc)
          next[id].orders.date_asc = remap(next[id].orders.date_asc);
        if (next[id].orders.date_desc)
          next[id].orders.date_desc = remap(next[id].orders.date_desc);
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
    const allIds = Object.keys(LISTS);
    const keep = Array.isArray(PREFS.order)
      ? PREFS.order.filter((id) => LISTS[id])
      : [];
    const missingO = allIds.filter((id) => !keep.includes(id));
    PREFS.order = keep.concat(missingO);

    if (Array.isArray(PREFS.enabled) && PREFS.enabled.length) {
      PREFS.enabled = PREFS.enabled.filter((id) => LISTS[id]);
    }

    const valid = new Set(Object.keys(LISTS));
    if (PREFS.customOrder) {
      for (const k of Object.keys(PREFS.customOrder))
        if (!valid.has(k)) delete PREFS.customOrder[k];
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
      ep2ser: Object.fromEntries(EP2SER),
    });

    console.log(
      `[SYNC] ok – ${Object.values(LISTS).reduce(
        (n, L) => n + (L.ids?.length || 0),
        0
      )} items across ${Object.keys(LISTS).length} lists in ${minutes(
        Date.now() - started
      )} min`
    );
  } catch (e) {
    console.error("[SYNC] failed:", e);
  } finally {
    syncInProgress = false;
  }
}
function scheduleNextSync() {
  if (syncTimer) clearTimeout(syncTimer);
  if (IMDB_SYNC_MINUTES <= 0) return;
  syncTimer = setTimeout(
    () => fullSync({ rediscover: true }).then(scheduleNextSync),
    IMDB_SYNC_MINUTES * 60 * 1000
  );
}
function maybeBackgroundSync() {
  if (IMDB_SYNC_MINUTES <= 0) return;
  const stale =
    Date.now() - LAST_SYNC_AT > IMDB_SYNC_MINUTES * 60 * 1000;
  if (stale && !syncInProgress)
    fullSync({ rediscover: true }).then(scheduleNextSync);
}

// ----------------- SERVER -----------------
const app = express();
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});
app.use(express.json({ limit: "1mb" }));

function addonAllowed(req) {
  if (!SHARED_SECRET) return true;
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return u.searchParams.get("key") === SHARED_SECRET;
}
function adminAllowed(req) {
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return (
    (u.searchParams.get("admin") || req.headers["x-admin-key"]) ===
    ADMIN_PASSWORD
  );
}
const absoluteBase = (req) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
};

app.get("/health", (_req, res) => res.status(200).send("ok"));

// ------- Manifest -------
const baseManifest = {
  id: "org.mylists.snapshot",
  version: "12.4.3",
  name: "My Lists",
  description: "Your IMDb & Trakt lists as catalogs (cached).",
  resources: ["catalog", "meta"],
  types: ["my lists", "movie", "series"],
  idPrefixes: ["tt"],
  behaviorHints: {
    configurable: true,
    configurationRequired: false,
  },
};

function getEnabledOrderedIds() {
  const allIds = Object.keys(LISTS);
  const enabled = new Set(
    PREFS.enabled && PREFS.enabled.length ? PREFS.enabled : allIds
  );
  const base =
    PREFS.order && PREFS.order.length
      ? PREFS.order.filter((id) => LISTS[id])
      : [];
  const missing = allIds
    .filter((id) => !base.includes(id))
    .sort((a, b) =>
      (LISTS[a]?.name || a).localeCompare(LISTS[b]?.name || b)
    );
  const ordered = base.concat(missing);
  return ordered.filter((id) => enabled.has(id));
}

function catalogs() {
  const ids = getEnabledOrderedIds();
  return ids.map((lsid) => {
    const baseOpts =
      PREFS.sortOptions &&
      PREFS.sortOptions[lsid] &&
      PREFS.sortOptions[lsid].length
        ? PREFS.sortOptions[lsid]
        : SORT_OPTIONS;

    const def =
      (PREFS.perListSort && PREFS.perListSort[lsid]) || "name_asc";

    const options = Array.from(
      new Set([def].concat(baseOpts.filter((o) => o !== def)))
    );

    return {
      type: "my lists",
      id: `list:${lsid}`,
      name: `🗂 ${LISTS[lsid]?.name || lsid}`,
      extraSupported: ["search", "skip", "limit", "sort"],
      extra: [
        { name: "search" },
        { name: "skip" },
        { name: "limit" },
        { name: "sort", options },
      ],
      posterShape: "poster",
    };
  });
}
app.get("/manifest.json", (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();
    const version = `${baseManifest.version}-${MANIFEST_REV}`;
    res.json({
      ...baseManifest,
      version,
      catalogs: catalogs(),
      configuration: `${absoluteBase(req)}/configure`,
    });
  } catch (e) {
    console.error("manifest:", e);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/configure", (req, res) => {
  const base = absoluteBase(req);
  const dest = `${base}/admin?admin=${encodeURIComponent(
    ADMIN_PASSWORD
  )}`;

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
function parseExtra(extraStr, qObj) {
  const p = new URLSearchParams(extraStr || "");
  return { ...Object.fromEntries(p.entries()), ...(qObj || {}) };
}
app.get("/catalog/:type/:id/:extra?.json", (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const { id } = req.params;
    if (!id || !id.startsWith("list:")) return res.json({ metas: [] });
    const lsid = id.slice(5);
    const list = LISTS[lsid];
    if (!list) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q = String(extra.search || "").toLowerCase().trim();
    const sortReq = String(extra.sort || "").toLowerCase();
    const defaultSort =
      (PREFS.perListSort && PREFS.perListSort[lsid]) || "name_asc";
    const sort = sortReq || defaultSort;
    const skip = Math.max(0, Number(extra.skip || 0));
    const limit = Math.min(Number(extra.limit || 100), 200);

    // apply per-list edits (immediate effect)
    let ids = (list.ids || []).slice();
    const ed = (PREFS.listEdits && PREFS.listEdits[lsid]) || {};
    const removed = new Set((ed.removed || []).filter(isImdb));
    if (removed.size) ids = ids.filter((tt) => !removed.has(tt));
    const toAdd = (ed.added || []).filter(isImdb);
    for (const tt of toAdd) if (!ids.includes(tt)) ids.push(tt);

    let metas = ids.map((tt) => CARD.get(tt) || cardFor(tt));

    if (q) {
      metas = metas.filter(
        (m) =>
          (m.name || "").toLowerCase().includes(q) ||
          (m.id || "").toLowerCase().includes(q) ||
          (m.description || "").toLowerCase().includes(q)
      );
    }

    if (sort === "custom") metas = applyCustomOrder(metas, lsid);
    else if (sort === "imdb") metas = sortByOrderKey(metas, lsid, "imdb");
    else if (sort === "date_asc" || sort === "date_desc") {
      const haveImdbOrder =
        LISTS[lsid]?.orders &&
        Array.isArray(LISTS[lsid].orders[sort]) &&
        LISTS[lsid].orders[sort].length;
      metas = haveImdbOrder
        ? sortByOrderKey(metas, lsid, sort)
        : stableSort(metas, sort);
    } else metas = stableSort(metas, sort);

    // Always use portrait posters in Stremio
    metas = metas.map((m) => {
      const rec = BEST.get(m.id);
      const bg = rec && rec.meta && (rec.meta.background || rec.meta.backdrop);
      const portrait = m.posterPortrait || m.poster || m.posterLandscape || bg;
      const landscape = m.posterLandscape || bg || m.poster || m.posterPortrait;
      return { ...m, poster: portrait || landscape };
    });

    res.json({ metas: metas.slice(skip, skip + limit) });
  } catch (e) {
    console.error("catalog:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ------- Meta -------
app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const imdbId = req.params.id;
    if (!isImdb(imdbId))
      return res.json({
        meta: { id: imdbId, type: "movie", name: "Unknown item" },
      });

    let rec = BEST.get(imdbId);
    if (!rec) rec = await getBestMeta(imdbId);
    if (!rec || !rec.meta) {
      const fb = FALLBK.get(imdbId) || {};
      return res.json({
        meta: {
          id: imdbId,
          type: rec?.kind || fb.type || "movie",
          name: fb.name || imdbId,
          poster: fb.poster || undefined,
        },
      });
    }

    const m = rec.meta;
    res.json({
      meta: {
        ...m,
        id: imdbId,
        type: rec.kind,
      },
    });
  } catch (e) {
    console.error("meta:", e);
    res.status(500).send("Internal Server Error");
  }
});

// ------- Admin JSON APIs -------
app.get("/api/lists", (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  res.json(LISTS);
});
app.get("/api/prefs", (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  res.json(PREFS);
});
app.post("/api/prefs", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const body = req.body || {};

    // ---- merge fields, with validation ----
    if (Array.isArray(body.enabled)) {
      PREFS.enabled = body.enabled.filter((id) => isListId(id) && LISTS[id]);
    }

    if (Array.isArray(body.order)) {
      const seen = new Set();
      PREFS.order = body.order.filter((id) => {
        if (!LISTS[id] || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }

    if (typeof body.defaultList === "string") {
      PREFS.defaultList = LISTS[body.defaultList] ? body.defaultList : "";
    }

    if (body.perListSort && typeof body.perListSort === "object") {
      PREFS.perListSort = PREFS.perListSort || {};
      for (const [lsid, s] of Object.entries(body.perListSort)) {
        if (!LISTS[lsid]) continue;
        const v = String(s || "").toLowerCase();
        if (VALID_SORT.has(v)) PREFS.perListSort[lsid] = v;
      }
    }

    if (body.sortOptions && typeof body.sortOptions === "object") {
      PREFS.sortOptions = PREFS.sortOptions || {};
      for (const [lsid, arr] of Object.entries(body.sortOptions)) {
        if (!LISTS[lsid]) continue;
        PREFS.sortOptions[lsid] = clampSortOptions(arr);
      }
    }

    if (body.customOrder && typeof body.customOrder === "object") {
      PREFS.customOrder = PREFS.customOrder || {};
      for (const [lsid, arr] of Object.entries(body.customOrder)) {
        if (!LISTS[lsid]) continue;
        if (!Array.isArray(arr)) continue;
        const ids = arr.filter(isImdb);
        PREFS.customOrder[lsid] = ids;
      }
    }

    if (body.listEdits && typeof body.listEdits === "object") {
      PREFS.listEdits = PREFS.listEdits || {};
      for (const [lsid, ed] of Object.entries(body.listEdits)) {
        if (!LISTS[lsid]) continue;
        const added = Array.isArray(ed.added)
          ? ed.added.filter(isImdb)
          : [];
        const removed = Array.isArray(ed.removed)
          ? ed.removed.filter(isImdb)
          : [];
        PREFS.listEdits[lsid] = { added, removed };
      }
    }

    if (body.sources && typeof body.sources === "object") {
      PREFS.sources = PREFS.sources || { users: [], lists: [] };
      if (Array.isArray(body.sources.users)) {
        PREFS.sources.users = body.sources.users
          .map((s) => String(s || "").trim())
          .filter(Boolean);
      }
      if (Array.isArray(body.sources.lists)) {
        PREFS.sources.lists = body.sources.lists
          .map((s) => String(s || "").trim())
          .filter(Boolean);
      }
    }

    if (Array.isArray(body.blocked)) {
      PREFS.blocked = body.blocked
        .map((id) => String(id || "").trim())
        .filter(isListId);
    }

    if (typeof body.upgradeEpisodes === "boolean") {
      PREFS.upgradeEpisodes = body.upgradeEpisodes;
    }

    // posterShape kept only for backwards compat
    if (body.posterShape && typeof body.posterShape === "object") {
      PREFS.posterShape = body.posterShape;
    }

    const newKey = manifestKey();
    if (newKey !== LAST_MANIFEST_KEY) {
      LAST_MANIFEST_KEY = newKey;
      MANIFEST_REV++;
      console.log("[PREFS] updated → manifest rev", MANIFEST_REV);
    }

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER),
    });

    res.json({ ok: true, manifestRev: MANIFEST_REV, prefs: PREFS });
  } catch (e) {
    console.error("prefs:", e);
    res.status(500).send("Internal Server Error");
  }
});

// manual sync trigger from admin
app.post("/api/sync", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    await fullSync({ rediscover: true });
    scheduleNextSync();
    res.json({
      ok: true,
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
    });
  } catch (e) {
    console.error("manual sync:", e);
    res.status(500).json({ ok: false, error: String(e && e.message) });
  }
});

app.get("/api/status", (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  res.json({
    lastSyncAt: LAST_SYNC_AT,
    manifestRev: MANIFEST_REV,
    listCount: Object.keys(LISTS).length,
    itemCount: Object.values(LISTS).reduce(
      (n, L) => n + (L.ids?.length || 0),
      0
    ),
    syncInProgress,
  });
});

// ------- Admin UI (single-page) -------
app.get("/admin", (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  const base = absoluteBase(req);
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>My Lists – Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    color-scheme: dark;
    --bg:#050510;
    --bg2:#111325;
    --bg3:#181a30;
    --border:#25284a;
    --accent:#7c5cff;
    --accent-soft:rgba(124,92,255,0.15);
    --text:#f7f7fb;
    --muted:#a0a3c2;
    --danger:#ff5c7c;
  }
  * { box-sizing:border-box; }
  body {
    margin:0;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: radial-gradient(circle at top, #181830 0, #050510 60%);
    color: var(--text);
    min-height: 100vh;
  }
  .shell {
    max-width: 1100px;
    margin: 16px auto 32px;
    padding: 0 12px;
  }
  header {
    display:flex;
    flex-wrap:wrap;
    align-items:center;
    justify-content:space-between;
    gap:12px;
    margin-bottom:12px;
  }
  .title {
    font-size: 22px;
    font-weight: 600;
    display:flex;
    align-items:center;
    gap:8px;
  }
  .title span.logo {
    display:inline-flex;
    align-items:center;
    justify-content:center;
    width:28px;
    height:28px;
    border-radius:8px;
    background:linear-gradient(135deg,#7c5cff,#ff8ed4);
    color:white;
    font-size:16px;
    font-weight:700;
  }
  .sub {
    font-size:13px;
    color: var(--muted);
  }
  .pill {
    display:inline-flex;
    align-items:center;
    gap:6px;
    font-size:12px;
    padding:4px 10px;
    border-radius:999px;
    background:rgba(15,12,40,0.8);
    border:1px solid rgba(255,255,255,0.08);
  }
  .pill-dot {
    width:8px;height:8px;
    border-radius:999px;
    background:#36c07b;
    box-shadow:0 0 6px rgba(54,192,123,0.9);
  }
  .pill-muted {
    background:rgba(15,12,40,0.6);
    border-color:rgba(255,255,255,0.06);
  }

  .tabs {
    display:flex;
    gap:4px;
    border-radius:999px;
    background:rgba(12,10,30,0.9);
    padding:3px;
    border:1px solid rgba(255,255,255,0.05);
  }
  .tab-btn {
    flex:1;
    font-size:13px;
    padding:6px 10px;
    border-radius:999px;
    border:none;
    background:transparent;
    color:var(--muted);
    cursor:pointer;
    display:flex;
    align-items:center;
    justify-content:center;
    gap:6px;
  }
  .tab-btn.active {
    background:var(--accent-soft);
    color:var(--text);
  }

  .grid {
    display:grid;
    grid-template-columns: minmax(0, 1.3fr) minmax(0, 1.7fr);
    gap:12px;
  }
  @media (max-width: 800px) {
    .grid { grid-template-columns: 1fr; }
  }

  .card {
    background:rgba(11,9,28,0.96);
    border-radius:18px;
    border:1px solid var(--border);
    padding:12px 12px 10px;
    box-shadow:0 20px 40px rgba(0,0,0,0.5);
  }
  .card-header {
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:8px;
    margin-bottom:8px;
  }
  .card-title {
    font-size:14px;
    font-weight:600;
  }
  .card-sub {
    font-size:11px;
    color:var(--muted);
  }

  .lists-table {
    max-height:340px;
    overflow:auto;
    border-radius:10px;
    border:1px solid rgba(255,255,255,0.06);
    background:rgba(8,7,22,0.9);
  }
  table {
    width:100%;
    border-collapse:collapse;
    font-size:13px;
  }
  thead {
    background:rgba(8,7,22,0.95);
    position:sticky;
    top:0;
    z-index:1;
  }
  th, td {
    padding:6px 8px;
    text-align:left;
    border-bottom:1px solid rgba(255,255,255,0.04);
  }
  tbody tr:nth-child(even) {
    background:rgba(255,255,255,0.01);
  }
  tbody tr.dragging {
    opacity:0.6;
  }
  .handle {
    cursor:grab;
    font-size:13px;
    opacity:0.5;
  }
  .badge {
    display:inline-flex;
    align-items:center;
    padding:2px 6px;
    border-radius:999px;
    font-size:11px;
    border:1px solid rgba(255,255,255,0.08);
    background:rgba(255,255,255,0.02);
    color:var(--muted);
  }

  .toggle {
    position:relative;
    width:34px;
    height:18px;
  }
  .toggle input {
    opacity:0;
    width:0;height:0;
  }
  .toggle span {
    position:absolute;
    cursor:pointer;
    inset:0;
    background:#343653;
    border-radius:999px;
    transition:0.18s;
  }
  .toggle span:before {
    content:"";
    position:absolute;
    height:14px;width:14px;
    left:2px;top:2px;
    border-radius:50%;
    background:#0b0b18;
    transition:0.18s;
  }
  .toggle input:checked + span {
    background:linear-gradient(135deg,#7c5cff,#46d4ff);
  }
  .toggle input:checked + span:before {
    transform:translateX(16px);
    background:#fff;
  }

  .select, .input, .btn {
    font-size:13px;
    border-radius:999px;
    border:1px solid rgba(255,255,255,0.08);
    padding:4px 10px;
    background:rgba(10,9,26,0.95);
    color:var(--text);
    font-family:inherit;
  }
  .select, .input {
    width:100%;
  }
  .input::placeholder {
    color:rgba(160,163,194,0.7);
  }

  .btn {
    display:inline-flex;
    align-items:center;
    gap:6px;
    cursor:pointer;
    background:linear-gradient(135deg,#7c5cff,#46d4ff);
    border:none;
    color:white;
    font-weight:500;
    padding:5px 12px;
    box-shadow:0 6px 16px rgba(0,0,0,0.45);
  }
  .btn-ghost {
    background:rgba(10,9,26,0.9);
    color:var(--muted);
    border:1px solid rgba(255,255,255,0.08);
    box-shadow:none;
  }
  .btn-danger {
    background:linear-gradient(135deg,#ff5c7c,#ff9f70);
    border:none;
  }
  .btn-sm {
    font-size:11px;
    padding:3px 8px;
  }

  .chip-row {
    display:flex;
    flex-wrap:wrap;
    gap:6px;
  }
  .chip {
    border-radius:999px;
    border:1px solid rgba(255,255,255,0.1);
    padding:2px 8px;
    font-size:11px;
    color:var(--muted);
    cursor:pointer;
    background:rgba(9,8,24,0.9);
  }
  .chip.active {
    background:var(--accent-soft);
    color:var(--text);
    border-color:rgba(124,92,255,0.8);
  }

  .status-row {
    display:flex;
    flex-wrap:wrap;
    gap:8px;
    font-size:11px;
    color:var(--muted);
    align-items:center;
  }

  .saved-tick {
    display:inline-flex;
    align-items:center;
    gap:4px;
    font-size:11px;
    color:#36c07b;
  }

  .flex {
    display:flex;
    gap:6px;
    flex-wrap:wrap;
  }
  .flex-between {
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:6px;
  }
  .mt8 { margin-top:8px; }
  .mt4 { margin-top:4px; }
  .mt12 { margin-top:12px; }

  .items-table {
    max-height:310px;
    overflow:auto;
    border-radius:10px;
    border:1px solid rgba(255,255,255,0.07);
    background:rgba(8,7,22,0.9);
  }

  .align-right { text-align:right; }
</style>
</head>
<body>
<div class="shell">
  <header>
    <div>
      <div class="title">
        <span class="logo">M</span>
        <div>
          My Lists – Admin
          <div class="sub">IMDb + Trakt → Stremio catalogs • v12.4.3</div>
        </div>
      </div>
    </div>
    <div class="flex" style="align-items:center;">
      <div class="pill" id="pill-status">
        <span class="pill-dot"></span>
        <span id="status-text">Loading status…</span>
      </div>
      <div class="pill pill-muted">
        manifest rev <span id="rev-label">–</span>
      </div>
      <div class="tabs">
        <button class="tab-btn active" data-tab="lists">Lists</button>
        <button class="tab-btn" data-tab="customize">Customize</button>
        <button class="tab-btn" data-tab="sources">Sources & Sync</button>
      </div>
    </div>
  </header>

  <div id="tab-lists" class="grid">
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Lists & manifest order</div>
          <div class="card-sub">Drag rows to change manifest order. Toggle which lists are enabled.</div>
        </div>
        <button class="btn btn-sm" id="btn-save-lists">Save</button>
      </div>
      <div class="lists-table">
        <table id="lists-table">
          <thead>
            <tr>
              <th style="width:30px;"></th>
              <th>Enabled</th>
              <th>Name</th>
              <th>ID</th>
              <th class="align-right">Items</th>
            </tr>
          </thead>
          <tbody id="lists-body">
          </tbody>
        </table>
      </div>
      <div class="status-row mt8">
        <span id="lists-saved" style="display:none;" class="saved-tick">✔ Saved</span>
        <span id="lists-msg"></span>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Default list & global options</div>
          <div class="card-sub">Choose which catalog opens first and control per-list sort behaviour.</div>
        </div>
      </div>
      <div>
        <label style="font-size:12px;">Default list in Stremio</label>
        <select id="default-list" class="select mt4"></select>

        <div class="mt12">
          <div class="card-sub">Episode → series upgrade</div>
          <div class="flex-between mt4">
            <span style="font-size:12px;">Upgrade episodes to series where possible</span>
            <label class="toggle">
              <input type="checkbox" id="upgrade-episodes">
              <span></span>
            </label>
          </div>
        </div>

        <div class="mt12">
          <div class="card-sub">Quick actions</div>
          <div class="flex mt4">
            <button class="btn btn-sm btn-ghost" id="btn-refresh-status">Refresh status</button>
            <button class="btn btn-sm" id="btn-sync-now">Full sync now</button>
          </div>
        </div>

        <div class="mt12 status-row" id="status-meta">
          <span>Lists: <strong id="list-count">–</strong></span>
          <span>Items: <strong id="item-count">–</strong></span>
          <span>Last sync: <strong id="last-sync">never</strong></span>
        </div>
      </div>
    </div>
  </div>

  <div id="tab-customize" class="grid" style="display:none;">
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Per-list sort & view</div>
          <div class="card-sub">Set default sort used in Stremio and allowed sort options.</div>
        </div>
        <button class="btn btn-sm" id="btn-save-sort">Save</button>
      </div>
      <div>
        <label style="font-size:12px;">List</label>
        <select id="custom-list" class="select mt4"></select>

        <div class="mt12">
          <label style="font-size:12px;">Default sort for this list</label>
          <select id="list-default-sort" class="select mt4"></select>
        </div>

        <div class="mt12">
          <div class="card-sub">Sort options shown in Stremio</div>
          <div id="sort-options-chips" class="chip-row mt4"></div>
        </div>

        <div class="mt12">
          <div class="card-sub">Debug</div>
          <div class="status-row mt4">
            <span>Current default sort: <strong id="debug-default-sort">–</strong></span>
          </div>
        </div>

        <div class="mt12 status-row">
          <span id="sort-saved" style="display:none;" class="saved-tick">✔ Saved</span>
          <span id="sort-msg"></span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Custom order (drag, up/down)</div>
          <div class="card-sub">Drag rows or use ↑ / ↓ to create a custom order for this list.</div>
        </div>
        <div class="flex">
          <button class="btn btn-sm btn-ghost" id="btn-sort-preview">Apply default sort here</button>
          <button class="btn btn-sm" id="btn-save-order">Save order</button>
        </div>
      </div>
      <div class="flex-between mt4">
        <input class="input" id="items-search" placeholder="Filter by title / IMDb id…">
        <span style="font-size:11px;color:var(--muted);" id="items-count-label">0 items</span>
      </div>
      <div class="items-table mt4">
        <table>
          <thead>
            <tr>
              <th style="width:26px;"></th>
              <th>Title</th>
              <th>IMDb</th>
              <th style="width:80px;">Move</th>
            </tr>
          </thead>
          <tbody id="items-body"></tbody>
        </table>
      </div>
      <div class="status-row mt8">
        <span id="order-saved" style="display:none;" class="saved-tick">✔ Order saved (manifest rev <span id="order-rev"></span>)</span>
        <span id="order-msg"></span>
      </div>
    </div>
  </div>

  <div id="tab-sources" class="grid" style="display:none;">
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">IMDb / Trakt sources</div>
          <div class="card-sub">Add extra /lists URLs, user /lists pages and block lists you don’t want.</div>
        </div>
        <button class="btn btn-sm" id="btn-save-sources">Save & Rediscover</button>
      </div>
      <div>
        <label style="font-size:12px;">Extra user /lists pages (IMDb or Trakt)</label>
        <textarea id="sources-users" class="input mt4" rows="3" style="border-radius:10px; resize:vertical;"></textarea>

        <div class="mt12">
          <label style="font-size:12px;">Explicit lists (IMDb list URLs/ids, Trakt lists)</label>
          <textarea id="sources-lists" class="input mt4" rows="3" style="border-radius:10px; resize:vertical;"></textarea>
        </div>

        <div class="mt12">
          <label style="font-size:12px;">Blocked list IDs</label>
          <textarea id="sources-blocked" class="input mt4" rows="2" style="border-radius:10px; resize:vertical;"></textarea>
        </div>

        <div class="mt12 status-row">
          <span id="sources-saved" style="display:none;" class="saved-tick">✔ Saved</span>
          <span id="sources-msg"></span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Sync & snapshot</div>
          <div class="card-sub">Manual sync is cached and safe to press. Snapshot is pushed to GitHub if enabled.</div>
        </div>
      </div>
      <div>
        <div class="card-sub">Manual sync</div>
        <div class="flex mt4">
          <button class="btn btn-sm" id="btn-sync2">Full sync now</button>
          <button class="btn btn-sm btn-ghost" id="btn-refresh2">Refresh status</button>
        </div>
        <div class="mt12 card-sub">Snapshot</div>
        <div class="mt4" style="font-size:11px;color:var(--muted);">
          Snapshot is automatically saved after every change.<br>
          If GitHub integration is configured in Render env, <code>data/snapshot.json</code> is pushed as well.
        </div>
      </div>
    </div>
  </div>
</div>

<script>
(function(){
  const adminKey = new URLSearchParams(location.search).get("admin") || "";
  const headers = { "x-admin-key": adminKey, "Content-Type":"application/json" };

  let lists = {};
  let prefs = {};
  let currentListId = "";

  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabViews = {
    lists: document.getElementById("tab-lists"),
    customize: document.getElementById("tab-customize"),
    sources: document.getElementById("tab-sources")
  };

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      tabButtons.forEach(b => b.classList.toggle("active", b===btn));
      Object.entries(tabViews).forEach(([k,el]) => {
        el.style.display = (k===tab) ? "" : "none";
      });
    });
  });

  const elListsBody = document.getElementById("lists-body");
  const elListsSaved = document.getElementById("lists-saved");
  const elListsMsg = document.getElementById("lists-msg");
  const elDefaultList = document.getElementById("default-list");
  const elUpgrade = document.getElementById("upgrade-episodes");
  const elListCount = document.getElementById("list-count");
  const elItemCount = document.getElementById("item-count");
  const elLastSync = document.getElementById("last-sync");
  const elStatusText = document.getElementById("status-text");
  const elRevLabel = document.getElementById("rev-label");
  const elPillStatus = document.getElementById("pill-status");

  const elCustomList = document.getElementById("custom-list");
  const elListDefaultSort = document.getElementById("list-default-sort");
  const elSortChips = document.getElementById("sort-options-chips");
  const elSortSaved = document.getElementById("sort-saved");
  const elSortMsg = document.getElementById("sort-msg");
  const elDebugDefaultSort = document.getElementById("debug-default-sort");

  const elItemsBody = document.getElementById("items-body");
  const elItemsSearch = document.getElementById("items-search");
  const elItemsCountLabel = document.getElementById("items-count-label");
  const elOrderSaved = document.getElementById("order-saved");
  const elOrderRev = document.getElementById("order-rev");
  const elOrderMsg = document.getElementById("order-msg");

  const elSourcesUsers = document.getElementById("sources-users");
  const elSourcesLists = document.getElementById("sources-lists");
  const elSourcesBlocked = document.getElementById("sources-blocked");
  const elSourcesSaved = document.getElementById("sources-saved");
  const elSourcesMsg = document.getElementById("sources-msg");

  function flash(el) {
    el.style.display = "inline-flex";
    setTimeout(()=>{ el.style.display = "none"; }, 1800);
  }

  function fetchJSON(url) {
    return fetch(url, { headers })
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
  }

  function postJSON(url, body) {
    return fetch(url, {
      method:"POST",
      headers,
      body: JSON.stringify(body || {})
    }).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); });
  }

  function renderListsTable() {
    const enabled = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));
    const order = Array.isArray(prefs.order) && prefs.order.length
      ? prefs.order.filter(id => lists[id])
      : Object.keys(lists).sort((a,b)=>(lists[a].name||a).localeCompare(lists[b].name||b));

    elListsBody.innerHTML = "";
    order.forEach(id => {
      const L = lists[id];
      const tr = document.createElement("tr");
      tr.dataset.id = id;
      tr.innerHTML = \`
        <td><span class="handle">☰</span></td>
        <td>
          <label class="toggle">
            <input type="checkbox" \${enabled.has(id)?"checked":""}>
            <span></span>
          </label>
        </td>
        <td>\${L.name || id}</td>
        <td><span class="badge">\${id}</span></td>
        <td class="align-right">\${(L.ids && L.ids.length) || 0}</td>
      \`;
      const checkbox = tr.querySelector("input[type=checkbox]");
      checkbox.addEventListener("change", () => {
        if (!checkbox.checked) enabled.delete(id); else enabled.add(id);
        prefs.enabled = Array.from(enabled);
      });
      elListsBody.appendChild(tr);
    });

    // drag & drop
    let dragRow = null;
    elListsBody.querySelectorAll("tr").forEach(row => {
      const handle = row.querySelector(".handle");
      handle.addEventListener("mousedown", (e) => {
        dragRow = row;
        row.classList.add("dragging");
      });
    });
    document.addEventListener("mouseup", () => {
      if (!dragRow) return;
      dragRow.classList.remove("dragging");
      dragRow = null;
      const newOrder = Array.from(elListsBody.querySelectorAll("tr")).map(tr => tr.dataset.id);
      prefs.order = newOrder;
    });
    elListsBody.addEventListener("mousemove", (e) => {
      if (!dragRow) return;
      const rows = Array.from(elListsBody.querySelectorAll("tr"));
      const y = e.clientY;
      const rects = rows.map(r => ({ r, top: r.getBoundingClientRect().top }));
      const before = rects.filter(o => o.top < y).pop();
      if (!before) {
        elListsBody.insertBefore(dragRow, rows[0]);
      } else {
        if (before.r.nextSibling !== dragRow) {
          elListsBody.insertBefore(dragRow, before.r.nextSibling);
        }
      }
    });
  }

  function renderDefaultListSelect() {
    const order = Array.isArray(prefs.order) && prefs.order.length
      ? prefs.order.filter(id => lists[id])
      : Object.keys(lists).sort((a,b)=>(lists[a].name||a).localeCompare(lists[b].name||b));

    elDefaultList.innerHTML = "<option value=''>– none –</option>";
    order.forEach(id => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = lists[id].name || id;
      if (prefs.defaultList === id) opt.selected = true;
      elDefaultList.appendChild(opt);
    });
  }

  function renderCustomListSelect() {
    const order = Array.isArray(prefs.order) && prefs.order.length
      ? prefs.order.filter(id => lists[id])
      : Object.keys(lists).sort((a,b)=>(lists[a].name||a).localeCompare(lists[b].name||b));
    elCustomList.innerHTML = "";
    order.forEach(id => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = lists[id].name || id;
      elCustomList.appendChild(opt);
    });
    if (!currentListId && order.length) currentListId = order[0] || "";
    if (currentListId) elCustomList.value = currentListId;
  }

  function getSortOptionsFor(lsid) {
    const base = (prefs.sortOptions && prefs.sortOptions[lsid] && prefs.sortOptions[lsid].length)
      ? prefs.sortOptions[lsid]
      : ${JSON.stringify(SORT_OPTIONS)};
    return base;
  }

  function renderSortSection() {
    const lsid = currentListId;
    if (!lsid || !lists[lsid]) {
      elListDefaultSort.innerHTML = "";
      elSortChips.innerHTML = "";
      elDebugDefaultSort.textContent = "–";
      return;
    }
    const def = (prefs.perListSort && prefs.perListSort[lsid]) || "name_asc";
    const options = Array.from(new Set([def].concat(getSortOptionsFor(lsid))));

    elListDefaultSort.innerHTML = "";
    options.forEach(o => {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o;
      if (o === def) opt.selected = true;
      elListDefaultSort.appendChild(opt);
    });

    elSortChips.innerHTML = "";
    const allOpts = ${JSON.stringify(SORT_OPTIONS)};
    const allowed = new Set(getSortOptionsFor(lsid));
    allOpts.forEach(o => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (allowed.has(o) ? " active" : "");
      chip.textContent = o;
      chip.addEventListener("click", () => {
        if (chip.classList.contains("active")) {
          chip.classList.remove("active");
          allowed.delete(o);
        } else {
          chip.classList.add("active");
          allowed.add(o);
        }
        prefs.sortOptions = prefs.sortOptions || {};
        prefs.sortOptions[lsid] = Array.from(allowed);
      });
      elSortChips.appendChild(chip);
    });

    elDebugDefaultSort.textContent = def;
  }

  function renderItemsTable(applyDefaultSort) {
    const lsid = currentListId;
    if (!lsid || !lists[lsid]) {
      elItemsBody.innerHTML = "";
      elItemsCountLabel.textContent = "0 items";
      return;
    }
    const list = lists[lsid];
    const baseIds = (list.ids || []).slice();

    let ids = baseIds.slice();
    const edits = (prefs.listEdits && prefs.listEdits[lsid]) || {};
    const removed = new Set((edits.removed || []).filter(id => /^tt\\d+/.test(id)));
    if (removed.size) ids = ids.filter(tt => !removed.has(tt));
    const added = (edits.added || []).filter(id => /^tt\\d+/.test(id));
    for (const tt of added) if (!ids.includes(tt)) ids.push(tt);

    let metas = ids.map(tt => window.__CARDS && window.__CARDS[tt] ? window.__CARDS[tt] : { id: tt, name: tt });

    const q = elItemsSearch.value.trim().toLowerCase();
    if (q) {
      metas = metas.filter(m =>
        (m.name || "").toLowerCase().includes(q) ||
        (m.id || "").toLowerCase().includes(q)
      );
    }

    if (applyDefaultSort) {
      const def = (prefs.perListSort && prefs.perListSort[lsid]) || "name_asc";
      const withKey = metas.map((m,i)=>({m,i}));
      const dir = def.endsWith("_asc") ? 1 : -1;
      const key = def.split("_")[0];
      const cmpNull = (a,b)=>a==null&&b==null?0:a==null?1:b==null?-1:a<b?-1:a>b?1:0;
      withKey.sort((A,B)=>{
        const a=A.m,b=B.m;
        let c=0;
        if (key==="date") c=cmpNull(Date.parse(a.releaseDate||"")||null, Date.parse(b.releaseDate||"")||null);
        else if (key==="rating") c=cmpNull(a.imdbRating??null,b.imdbRating??null);
        else if (key==="runtime") c=cmpNull(a.runtime??null,b.runtime??null);
        else c=(a.name||"").localeCompare(b.name||"");
        if(c===0)c=A.i-B.i;
        return c*dir;
      });
      metas = withKey.map(x=>x.m);
    } else {
      const custom = (prefs.customOrder && prefs.customOrder[lsid]) || [];
      const pos = new Map(custom.map((id,i)=>[id,i]));
      metas.sort((a,b)=>{
        const pa = pos.has(a.id)?pos.get(a.id):1e9;
        const pb = pos.has(b.id)?pos.get(b.id):1e9;
        if (pa!==pb) return pa-pb;
        return (a.name||"").localeCompare(b.name||"");
      });
    }

    elItemsBody.innerHTML = "";
    metas.forEach((m,idx) => {
      const tr = document.createElement("tr");
      tr.dataset.id = m.id;
      tr.innerHTML = \`
        <td><span class="handle">☰</span></td>
        <td>\${m.name || m.id}</td>
        <td><span class="badge">\${m.id}</span></td>
        <td>
          <div class="flex">
            <button type="button" class="btn btn-sm btn-ghost btn-up">↑</button>
            <button type="button" class="btn btn-sm btn-ghost btn-down">↓</button>
          </div>
        </td>
      \`;
      const up = tr.querySelector(".btn-up");
      const down = tr.querySelector(".btn-down");
      up.addEventListener("click", () => {
        const prev = tr.previousElementSibling;
        if (prev) elItemsBody.insertBefore(tr, prev);
      });
      down.addEventListener("click", () => {
        const next = tr.nextElementSibling;
        if (next) elItemsBody.insertBefore(next, tr.nextElementSibling);
      });
      elItemsBody.appendChild(tr);
    });

    elItemsCountLabel.textContent = metas.length + " items";

    // drag & drop here
    let dragRow = null;
    elItemsBody.querySelectorAll("tr").forEach(row => {
      const handle = row.querySelector(".handle");
      handle.addEventListener("mousedown", () => {
        dragRow = row;
        row.classList.add("dragging");
      });
    });
    document.addEventListener("mouseup", () => {
      if (!dragRow) return;
      dragRow.classList.remove("dragging");
      dragRow = null;
    });
    elItemsBody.addEventListener("mousemove", (e) => {
      if (!dragRow) return;
      const rows = Array.from(elItemsBody.querySelectorAll("tr"));
      const y = e.clientY;
      const rects = rows.map(r => ({ r, top: r.getBoundingClientRect().top }));
      const before = rects.filter(o => o.top < y).pop();
      if (!before) {
        elItemsBody.insertBefore(dragRow, rows[0]);
      } else {
        if (before.r.nextSibling !== dragRow) {
          elItemsBody.insertBefore(dragRow, before.r.nextSibling);
        }
      }
    });
  }

  function collectCustomOrder() {
    const lsid = currentListId;
    if (!lsid || !lists[lsid]) return;
    const ids = Array.from(elItemsBody.querySelectorAll("tr")).map(tr => tr.dataset.id);
    prefs.customOrder = prefs.customOrder || {};
    prefs.customOrder[lsid] = ids;
  }

  function loadStatus() {
    return fetchJSON("/api/status").then(s => {
      elListCount.textContent = s.listCount ?? "0";
      elItemCount.textContent = s.itemCount ?? "0";
      elRevLabel.textContent = s.manifestRev ?? "–";
      if (s.lastSyncAt) {
        const d = new Date(s.lastSyncAt);
        elLastSync.textContent = d.toLocaleString();
      } else {
        elLastSync.textContent = "never";
      }
      elStatusText.textContent = s.syncInProgress ? "Sync in progress…" : "Idle";
      elPillStatus.querySelector(".pill-dot").style.background = s.syncInProgress ? "#ffb347" : "#36c07b";
    }).catch(e => {
      elStatusText.textContent = "Status error";
      console.error(e);
    });
  }

  // ---- buttons ----
  document.getElementById("btn-save-lists").addEventListener("click", () => {
    const body = {
      enabled: prefs.enabled,
      order: prefs.order,
      defaultList: elDefaultList.value || "",
      upgradeEpisodes: elUpgrade.checked
    };
    postJSON("/api/prefs", body).then(r => {
      elRevLabel.textContent = r.manifestRev ?? "–";
      flash(elListsSaved);
      elListsMsg.textContent = "";
    }).catch(e => {
      elListsMsg.textContent = "Error saving: " + e.message;
    });
  });

  document.getElementById("btn-refresh-status").addEventListener("click", () => {
    loadStatus();
  });
  document.getElementById("btn-sync-now").addEventListener("click", () => {
    postJSON("/api/sync", {}).then(r => {
      elRevLabel.textContent = r.manifestRev ?? "–";
      loadStatus();
    }).catch(e => alert("Sync failed: "+e.message));
  });

  document.getElementById("btn-save-sort").addEventListener("click", () => {
    const lsid = currentListId;
    if (!lsid) return;
    const def = elListDefaultSort.value || "name_asc";
    prefs.perListSort = prefs.perListSort || {};
    prefs.perListSort[lsid] = def;
    const chipsActive = Array.from(elSortChips.querySelectorAll(".chip.active")).map(c => c.textContent);
    prefs.sortOptions = prefs.sortOptions || {};
    prefs.sortOptions[lsid] = chipsActive;
    const body = {
      perListSort: prefs.perListSort,
      sortOptions: prefs.sortOptions
    };
    postJSON("/api/prefs", body).then(r => {
      prefs = r.prefs || prefs;
      elRevLabel.textContent = r.manifestRev ?? "–";
      elDebugDefaultSort.textContent = prefs.perListSort[lsid] || "name_asc";
      flash(elSortSaved);
      elSortMsg.textContent = "";
    }).catch(e => {
      elSortMsg.textContent = "Error: " + e.message;
    });
  });

  document.getElementById("btn-sort-preview").addEventListener("click", () => {
    renderItemsTable(true);
  });

  document.getElementById("btn-save-order").addEventListener("click", () => {
    collectCustomOrder();
    const body = { customOrder: prefs.customOrder };
    postJSON("/api/prefs", body).then(r => {
      prefs = r.prefs || prefs;
      elRevLabel.textContent = r.manifestRev ?? "–";
      elOrderRev.textContent = r.manifestRev ?? "–";
      flash(elOrderSaved);
      elOrderMsg.textContent = "";
    }).catch(e => {
      elOrderMsg.textContent = "Error: " + e.message;
    });
  });

  elCustomList.addEventListener("change", () => {
    currentListId = elCustomList.value;
    renderSortSection();
    renderItemsTable(false);
  });

  elItemsSearch.addEventListener("input", () => {
    renderItemsTable(false);
  });

  document.getElementById("btn-save-sources").addEventListener("click", () => {
    const users = elSourcesUsers.value.split(/\\r?\\n/).map(s=>s.trim()).filter(Boolean);
    const listsLines = elSourcesLists.value.split(/\\r?\\n/).map(s=>s.trim()).filter(Boolean);
    const blocked = elSourcesBlocked.value.split(/[,\\s]+/).map(s=>s.trim()).filter(Boolean);
    const body = {
      sources: { users, lists: listsLines },
      blocked
    };
    postJSON("/api/prefs", body).then(r => {
      prefs = r.prefs || prefs;
      elRevLabel.textContent = r.manifestRev ?? "–";
      flash(elSourcesSaved);
      elSourcesMsg.textContent = "";
    }).catch(e => {
      elSourcesMsg.textContent = "Error: " + e.message;
    });
  });

  document.getElementById("btn-sync2").addEventListener("click", () => {
    postJSON("/api/sync", {}).then(r => {
      elRevLabel.textContent = r.manifestRev ?? "–";
      loadStatus();
    }).catch(e => alert("Sync failed: "+e.message));
  });
  document.getElementById("btn-refresh2").addEventListener("click", () => {
    loadStatus();
  });

  // Initial load
  Promise.all([
    fetchJSON("/api/lists"),
    fetchJSON("/api/prefs"),
    fetchJSON("/api/status").catch(()=>null)
  ]).then(([L,P,S]) => {
    lists = L || {};
    prefs = P || prefs;
    window.__CARDS = {}; // optional placeholder for future client-side meta
    elUpgrade.checked = !!prefs.upgradeEpisodes;

    renderListsTable();
    renderDefaultListSelect();
    renderCustomListSelect();
    renderSortSection();
    renderItemsTable(false);

    const srcUsers = (prefs.sources && prefs.sources.users) || [];
    const srcLists = (prefs.sources && prefs.sources.lists) || [];
    const blocked = prefs.blocked || [];
    elSourcesUsers.value = srcUsers.join("\\n");
    elSourcesLists.value = srcLists.join("\\n");
    elSourcesBlocked.value = blocked.join("\\n");

    if (S) {
      elRevLabel.textContent = S.manifestRev ?? "–";
      if (S.lastSyncAt) {
        elLastSync.textContent = new Date(S.lastSyncAt).toLocaleString();
      }
      elListCount.textContent = S.listCount ?? Object.keys(lists).length;
      elItemCount.textContent = S.itemCount ?? 0;
      elStatusText.textContent = S.syncInProgress ? "Sync in progress…" : "Idle";
      elPillStatus.querySelector(".pill-dot").style.background = S.syncInProgress ? "#ffb347" : "#36c07b";
    } else {
      loadStatus();
    }
  }).catch(e => {
    elStatusText.textContent = "Error loading admin";
    console.error(e);
  });

})();
</script>
</body>
</html>`);
});

// ------- BOOTSTRAP -------
(async () => {
  try {
    const snap = await loadSnapshot();
    if (snap) {
      LISTS = snap.lists || LISTS;
      PREFS = { ...PREFS, ...(snap.prefs || {}) };

      if (snap.fallback) {
        for (const [k, v] of Object.entries(snap.fallback)) {
          FALLBK.set(k, v);
        }
      }
      if (snap.cards) {
        for (const [k, v] of Object.entries(snap.cards)) {
          CARD.set(k, v);
        }
      }
      if (snap.ep2ser) {
        for (const [k, v] of Object.entries(snap.ep2ser)) {
          EP2SER.set(k, v);
        }
      }
      LAST_SYNC_AT = snap.lastSyncAt || 0;
      MANIFEST_REV = snap.manifestRev || 1;
      LAST_MANIFEST_KEY = manifestKey();
      console.log("[BOOT] snapshot loaded – lists:", Object.keys(LISTS).length);
      maybeBackgroundSync();
    } else {
      console.log("[BOOT] no snapshot, running initial fullSync…");
      await fullSync({ rediscover: true });
      scheduleNextSync();
    }
  } catch (e) {
    console.error("[BOOT] error loading snapshot:", e);
    console.log("[BOOT] falling back to fullSync()");
    await fullSync({ rediscover: true });
    scheduleNextSync();
  }

  app.listen(PORT, HOST, () => {
    console.log("My Lists addon listening on " + HOST + ":" + PORT);
  });
})();
