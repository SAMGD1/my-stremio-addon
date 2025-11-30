/*  My Lists – IMDb → Stremio (custom per-list ordering, IMDb date order, Trakt, UI tabs, up/down reorder)
 *  v12.4.1
 */
"use strict";

const express = require("express");
const fs = require("fs/promises");

// ----------------- ENV -----------------
const PORT = Number(process.env.PORT || 7000);
const HOST = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Stremio_172";
const SHARED_SECRET = process.env.SHARED_SECRET || "";

const IMDB_USER_URL = process.env.IMDB_USER_URL || ""; // https://www.imdb.com/user/urXXXXXXX/lists/
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));
const UPGRADE_EPISODES = String(process.env.UPGRADE_EPISODES || "true").toLowerCase() !== "false";

const IMDB_FETCH_RELEASE_ORDERS =
  String(process.env.IMDB_FETCH_RELEASE_ORDERS || "true").toLowerCase() !== "false";

const IMDB_LIST_IDS = (process.env.IMDB_LIST_IDS || "")
  .split(/[,\s]+/)
  .map((s) => s.trim())
  .filter((s) => /^ls\d{6,}$/i.test(s));

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GH_ENABLED = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);
const SNAP_LOCAL = "data/snapshot.json";

// Trakt
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID || "";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/12.4.1";
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

let LISTS = Object.create(null);
/** PREFS saved to snapshot */
let PREFS = {
  listEdits: {},
  enabled: [],
  order: [],
  defaultList: "",
  perListSort: {},
  sortOptions: {},
  customOrder: {},
  posterShape: {},
  upgradeEpisodes: UPGRADE_EPISODES,
  sources: {
    users: [],
    lists: [],
  },
  blocked: [],
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
  try {
    await fs.mkdir("data", { recursive: true });
    await fs.writeFile(SNAP_LOCAL, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    /* ignore */
  }
  if (!GH_ENABLED) return;
  const content = Buffer.from(JSON.stringify(obj, null, 2)).toString("base64");
  const path = "data/snapshot.json";
  const sha = await ghGetSha(path);
  const body = { message: "Update snapshot.json", content, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  await gh("PUT", `/contents/${encodeURIComponent(path)}`, body);
}
async function loadSnapshot() {
  if (GH_ENABLED) {
    try {
      const data = await gh(
        "GET",
        `/contents/${encodeURIComponent("data/snapshot.json")}?ref=${encodeURIComponent(
          GITHUB_BRANCH
        )}`
      );
      const buf = Buffer.from(data.content, "base64").toString("utf8");
      return JSON.parse(buf);
    } catch {
      /* ignore */
    }
  }
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

function parseTraktGlobalListUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/trakt\.tv\/lists\/([^?#]+)/i);
  if (!m) return null;
  const id = decodeURIComponent(s.match(/trakt\.tv\/lists\/([^?#]+)/i)[1].replace(/\/+$/, ""));
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
          `/users/${encodeURIComponent(user)}/lists/${encodeURIComponent(
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
    const slug = (l.ids && l.ids.slug) || l.slug || String((l.ids && l.ids.trakt) || "");
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

  const m = s.match(/ls\d{6,}/i);
  if (m) return { id: m[0], url: `https://www.imdb.com/list/${m[0]}/` };

  if (/imdb\.com\/list\//i.test(s)) return { id: null, url: s };

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
  const re = /href=['"](?:https?:\/\/(?:www\.)?imdb\.com)?\/list\/(ls\d{6,})\/['"]/gi;
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
      return m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  }
  const t = html.match(/<title>(.*?)<\/title>/i);
  return t ? t[1].replace(/\s+\-\s*IMDb.*$/i, "").trim() : listUrl;
}
function tconstsFromHtml(html) {
  const out = [];
  const seen = new Set();
  let m;
  const re1 = /data-tconst=["'](tt\d{7,})["']/gi;
  while ((m = re1.exec(html))) if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  const re2 = /\/title\/(tt\d{7,})\//gi;
  while ((m = re2.exec(html))) if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
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
async function fetchImdbOrder(listUrl, sortSpec, maxPages = 80) {
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
      } catch {}
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
      ? ld["@graph"].find((x) => /TVEpisode/i.test(x["@type"])) || ld["@graph"][0]
      : ld;
    const part =
      node &&
      (node.partOfSeries ||
        node.partOfTVSeries ||
        (node.partOfSeason && node.partOfSeason.partOfSeries));
    const url = typeof part === "string" ? part : part && (part.url || part.sameAs || part["@id"]);
    if (url) {
      const m = String(url).match(/tt\d{7,}/i);
      if (m) seriesId = m[0];
    }
  } catch {}
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
      ? ld["@graph"].find((x) => x["@id"]?.includes(`/title/${imdbId}`)) || ld["@graph"][0]
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
  } catch {}
  const rec = {
    kind: type === "series" ? "series" : "movie",
    meta: name ? { name, poster, background, released, year } : null,
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
  const order =
    (PREFS.customOrder && PREFS.customOrder[lsid]) || [];
  if (!order || !order.length) return metas.slice();
  const pos = new Map(order.map((id, i) => [id, i]));
  return metas.slice().sort((a, b) => {
    const pa = pos.has(a.id) ? pos.get(a.id) : Number.MAX_SAFE_INTEGER;
    const pb = pos.has(b.id) ? pos.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return (a.name || "").localeCompare(b.name || "");
  });
}
function sortByOrderKey(metas, lsid, key) {
  const list = LISTS[lsid];
  if (!list) return metas.slice();
  const arr =
    list.orders &&
    Array.isArray(list.orders[key]) &&
    list.orders[key].length
      ? list.orders[key]
      : key === "imdb"
      ? list.ids || []
      : null;
  if (!arr) return metas.slice();
  const pos = new Map(arr.map((id, i) => [id, i]));
  return metas
    .slice()
    .sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
}

// ----------------- SYNC -----------------

function manifestKey() {
  const enabled =
    PREFS.enabled && PREFS.enabled.length
      ? PREFS.enabled
      : Object.keys(LISTS);
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

  // main imdb
  if (IMDB_USER_URL) {
    try {
      const arr = await discoverFromUserLists(IMDB_USER_URL);
      arr.forEach(add);
    } catch (e) {
      console.warn("[DISCOVER] main failed:", e.message);
    }
  }

  // extra user URLs (IMDb + Trakt)
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

  // explicit lists
  const addlRaw = (PREFS.sources?.lists || []).concat(IMDB_LIST_IDS || []);
  for (const raw of addlRaw) {
    const val = String(raw || "").trim();
    if (!val) continue;

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
            console.warn(
              "[TRAKT] meta fetch failed for",
              val,
              e.message
            );
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
            console.warn(
              "[TRAKT] global meta fetch failed for",
              val,
              e.message
            );
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

    const norm = normalizeListIdOrUrl(val);
    if (!norm) continue;
    let { id, url } = norm;
    if (!id) {
      const m = String(url).match(/ls\d{6,}/i);
      if (m) id = m[0];
    }
    if (!id) continue;

    let name = id;
    try {
      name = await fetchListName(url);
    } catch {}

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

    for (const tt of idsToPreload) {
      await getBestMeta(tt);
      CARD.set(tt, cardFor(tt));
    }

    LISTS = next;
    LAST_SYNC_AT = Date.now();

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
      )} items across ${
        Object.keys(LISTS).length
      } lists in ${minutes(Date.now() - started)} min`
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
    () =>
      fullSync({ rediscover: true }).then(() => scheduleNextSync()),
    IMDB_SYNC_MINUTES * 60 * 1000
  );
}
function maybeBackgroundSync() {
  if (IMDB_SYNC_MINUTES <= 0) return;
  const stale = Date.now() - LAST_SYNC_AT > IMDB_SYNC_MINUTES * 60 * 1000;
  if (stale && !syncInProgress)
    fullSync({ rediscover: true }).then(() => scheduleNextSync());
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

app.get("/health", (_, res) => res.status(200).send("ok"));

// ------- Manifest -------

const baseManifest = {
  id: "org.mylists.snapshot",
  version: "12.4.1",
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
  return ids.map((lsid) => ({
    type: "my lists",
    id: `list:${lsid}`,
    name: `🗂 ${LISTS[lsid]?.name || lsid}`,
    extraSupported: ["search", "skip", "limit", "sort"],
    extra: [
      { name: "search" },
      { name: "skip" },
      { name: "limit" },
      {
        name: "sort",
        options:
          PREFS.sortOptions &&
          PREFS.sortOptions[lsid] &&
          PREFS.sortOptions[lsid].length
            ? PREFS.sortOptions[lsid]
            : SORT_OPTIONS,
      },
    ],
    posterShape: (PREFS.posterShape && PREFS.posterShape[lsid]) || "poster",
  }));
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
  res
    .type("html")
    .send(`<!doctype html><meta charset="utf-8">
<title>Configure – My Lists</title>
<meta http-equiv="refresh" content="0; url='${dest}'">
<style>
body{font-family:system-ui; background:#0f0d1a; color:#f7f7fb;
display:grid; place-items:center; height:100vh; margin:0}
a{color:#9aa0b4;}
</style>
<p>Opening admin… <a href="${dest}">continue</a></p>`);
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

    const shape = (PREFS.posterShape && PREFS.posterShape[lsid]) || "poster";
    metas = metas.map((m) => {
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

// ------- Admin APIs -------

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
    PREFS.enabled = Array.isArray(body.enabled)
      ? body.enabled.filter(isListId)
      : [];
    PREFS.order = Array.isArray(body.order)
      ? body.order.filter(isListId)
      : [];
    PREFS.defaultList = isListId(body.defaultList) ? body.defaultList : "";
    PREFS.perListSort =
      body.perListSort && typeof body.perListSort === "object"
        ? body.perListSort
        : PREFS.perListSort || {};
    PREFS.sortOptions =
      body.sortOptions && typeof body.sortOptions === "object"
        ? Object.fromEntries(
            Object.entries(body.sortOptions).map(([k, v]) => [
              k,
              clampSortOptions(v),
            ])
          )
        : PREFS.sortOptions || {};

    PREFS.posterShape =
      body.posterShape && typeof body.posterShape === "object"
        ? Object.fromEntries(
            Object.entries(body.posterShape).filter(
              ([k, v]) =>
                isListId(k) && (v === "poster" || v === "landscape")
            )
          )
        : PREFS.posterShape || {};

    PREFS.upgradeEpisodes = !!body.upgradeEpisodes;

    if (body.customOrder && typeof body.customOrder === "object") {
      PREFS.customOrder = body.customOrder;
    }

    const src = body.sources || {};
    PREFS.sources = {
      users: Array.isArray(src.users)
        ? src.users.map((s) => String(s).trim()).filter(Boolean)
        : PREFS.sources.users || [],
      lists: Array.isArray(src.lists)
        ? src.lists.map((s) => String(s).trim()).filter(Boolean)
        : PREFS.sources.lists || [],
    };

    PREFS.blocked = Array.isArray(body.blocked)
      ? body.blocked.filter(isListId)
      : PREFS.blocked || [];

    // always bump manifest version on prefs save
    LAST_MANIFEST_KEY = manifestKey();
    MANIFEST_REV++;

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER),
    });

    res.status(200).send("Saved. Manifest rev " + MANIFEST_REV);
  } catch (e) {
    console.error("prefs save error:", e);
    res.status(500).send("Failed to save");
  }
});

app.post("/api/unblock-list", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lsid = String(req.body.lsid || "");
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    PREFS.blocked = (PREFS.blocked || []).filter((id) => id !== lsid);
    await fullSync({ rediscover: true });
    scheduleNextSync();
    res.status(200).send("Unblocked & synced");
  } catch (e) {
    console.error(e);
    res.status(500).send("Failed");
  }
});

app.get("/api/list-items", (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  const lsid = String(req.query.lsid || "");
  const list = LISTS[lsid];
  if (!list) return res.json({ items: [] });

  let ids = (list.ids || []).slice();
  const ed = (PREFS.listEdits && PREFS.listEdits[lsid]) || {};
  const removed = new Set((ed.removed || []).filter(isImdb));
  if (removed.size) ids = ids.filter((tt) => !removed.has(tt));
  const toAdd = (ed.added || []).filter(isImdb);
  for (const tt of toAdd) if (!ids.includes(tt)) ids.push(tt);

  const items = ids.map((tt) => {
    let c = CARD.get(tt) || cardFor(tt);
    if (!c.posterPortrait || !c.posterLandscape) {
      const rec = BEST.get(tt);
      const bg = rec && rec.meta && (rec.meta.background || rec.meta.backdrop);
      const portrait = c.posterPortrait || c.poster || c.posterLandscape || bg;
      const landscape = c.posterLandscape || bg || c.poster || c.posterPortrait;
      c = {
        ...c,
        posterPortrait: portrait || landscape,
        posterLandscape: landscape || portrait,
      };
      CARD.set(tt, c);
    }
    return c;
  });

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
    const ed =
      PREFS.listEdits[lsid] ||
      (PREFS.listEdits[lsid] = { added: [], removed: [] });
    if (!ed.added.includes(tt)) ed.added.push(tt);
    ed.removed = (ed.removed || []).filter((x) => x !== tt);

    await getBestMeta(tt);
    CARD.set(tt, cardFor(tt));

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER),
    });

    res.status(200).send("Added");
  } catch (e) {
    console.error(e);
    res.status(500).send("Failed");
  }
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
    const ed =
      PREFS.listEdits[lsid] ||
      (PREFS.listEdits[lsid] = { added: [], removed: [] });

    if (!ed.removed.includes(tt)) ed.removed.push(tt);
    ed.added = (ed.added || []).filter((x) => x !== tt);

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER),
    });

    res.status(200).send("Removed");
  } catch (e) {
    console.error(e);
    res.status(500).send("Failed");
  }
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
      ep2ser: Object.fromEntries(EP2SER),
    });

    res.status(200).send("Reset");
  } catch (e) {
    console.error(e);
    res.status(500).send("Failed");
  }
});

app.post("/api/custom-order", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lsid = String(req.body.lsid || "");
    const order = Array.isArray(req.body.order)
      ? req.body.order.filter(isImdb)
      : [];
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    const list = LISTS[lsid];
    if (!list) return res.status(404).send("List not found");

    const set = new Set(
      list.ids.concat(PREFS.listEdits?.[lsid]?.added || [])
    );
    const clean = order.filter((id) => set.has(id));

    PREFS.customOrder = PREFS.customOrder || {};
    PREFS.customOrder[lsid] = clean;
    PREFS.perListSort = PREFS.perListSort || {};
    PREFS.perListSort[lsid] = "custom";

    LAST_MANIFEST_KEY = manifestKey();
    MANIFEST_REV++;

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER),
    });

    res.status(200).json({ ok: true, manifestRev: MANIFEST_REV });
  } catch (e) {
    console.error("custom-order:", e);
    res.status(500).send("Failed");
  }
});

app.post("/api/add-sources", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const users = Array.isArray(req.body.users)
      ? req.body.users.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const lists = Array.isArray(req.body.lists)
      ? req.body.lists.map((s) => String(s).trim()).filter(Boolean)
      : [];
    PREFS.sources = PREFS.sources || { users: [], lists: [] };
    PREFS.sources.users = Array.from(
      new Set([...(PREFS.sources.users || []), ...users])
    );
    PREFS.sources.lists = Array.from(
      new Set([...(PREFS.sources.lists || []), ...lists])
    );
    await fullSync({ rediscover: true });
    scheduleNextSync();
    res.status(200).send("Sources added & synced");
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

app.post("/api/remove-list", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lsid = String(req.body.lsid || "");
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    delete LISTS[lsid];
    PREFS.enabled = (PREFS.enabled || []).filter((id) => id !== lsid);
    PREFS.order = (PREFS.order || []).filter((id) => id !== lsid);
    PREFS.blocked = Array.from(
      new Set([...(PREFS.blocked || []), lsid])
    );

    LAST_MANIFEST_KEY = "";
    MANIFEST_REV++;

    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER),
    });
    res.status(200).send("Removed & blocked");
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

app.post("/api/sync", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    await fullSync({ rediscover: true });
    scheduleNextSync();
    res
      .status(200)
      .send(
        `Synced at ${new Date().toISOString()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`
      );
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

app.post("/api/purge-sync", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    LISTS = Object.create(null);
    BEST.clear();
    FALLBK.clear();
    EP2SER.clear();
    CARD.clear();
    PREFS.customOrder = PREFS.customOrder || {};
    await fullSync({ rediscover: true });
    scheduleNextSync();
    res
      .status(200)
      .send(
        `Purged & synced at ${new Date().toISOString()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`
      );
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

app.get("/api/debug-imdb", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const url = IMDB_USER_URL || req.query.u;
    if (!url) return res.type("text").send("IMDB_USER_URL not set.");
    const html = await fetchText(withParam(url, "_", "dbg"));
    res.type("text").send(html.slice(0, 2000));
  } catch (e) {
    res
      .type("text")
      .status(500)
      .send("Fetch failed: " + e.message);
  }
});

// ------- Admin Page -------

app.get("/admin", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  const base = absoluteBase(req);
  const manifestUrl = `${base}/manifest.json${
    SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""
  }`;

  let discovered = [];
  try {
    discovered = await harvestSources();
  } catch {}

  const rows =
    Object.keys(LISTS)
      .map((id) => {
        const L = LISTS[id];
        const count = (L.ids || []).length;
        return `<li><b>${L.name || id}</b> <small>(${count} items)</small><br/><small>${L.url || ""}</small></li>`;
      })
      .join("") || "<li>(none)</li>";

  const disc =
    discovered
      .map(
        (d) =>
          `<li><b>${d.name || d.id}</b><br/><small>${d.url}</small></li>`
      )
      .join("") || "<li>(none)</li>";

  const lastSyncText = LAST_SYNC_AT
    ? new Date(LAST_SYNC_AT).toLocaleString() +
      " (" +
      Math.round((Date.now() - LAST_SYNC_AT) / 60000) +
      " min ago)"
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
}
.wrap{max-width:1200px;margin:24px auto;padding:0 16px}
.hero{padding:12px 0 4px}
h1{margin:0 0 4px;font-weight:700;font-size:28px;letter-spacing:.01em}
.subtitle{color:var(--muted);font-size:13px}

.navtabs{
  margin:8px 0 16px;
  display:flex;
  flex-wrap:wrap;
  gap:8px;
}
.navtab{
  padding:6px 14px;
  border-radius:999px;
  border:1px solid var(--border);
  background:rgba(10,8,30,.9);
  color:var(--muted);
  cursor:pointer;
  font-size:13px;
}
.navtab.active{
  background:var(--accent);
  color:#fff;
  border-color:var(--accent2);
}

/* stack cards full width */
.grid{
  display:block;
  margin-top:8px;
}

.card{
  border:1px solid var(--border);
  border-radius:18px;
  padding:16px 18px;
  background:linear-gradient(145deg,rgba(17,14,39,.96),rgba(8,6,25,.98));
  box-shadow:0 18px 40px rgba(0,0,0,.55);
  margin-bottom:16px;
}
h3{margin:0 0 8px;font-size:18px}
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
}
.thumbs.shape-poster .thumb-img{width:52px;height:78px}
.thumbs.shape-landscape .thumb-img{width:86px;height:52px}
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
.movebtn{
  background:#1c1837;
  box-shadow:none;
  padding:4px 7px;
  font-size:11px;
  margin:0 2px;
}

/* simple "pages" */
body.view-snapshot .card.snapshot{display:block;}
body.view-snapshot .card.sources,
body.view-snapshot .card.customize{display:none;}

body.view-sources .card.sources{display:block;}
body.view-sources .card.snapshot,
body.view-sources .card.customize{display:none;}

body.view-custom .card.customize{display:block;}
body.view-custom .card.snapshot,
body.view-custom .card.sources{display:none;}

.statusText{margin-left:8px;font-size:12px;color:var(--muted);}
.statusText.ok{color:#7bed9f;}
</style>
</head>
<body class="view-snapshot">
<div class="wrap">
  <div class="hero">
    <h1>My Lists – Admin</h1>
    <div class="subtitle">Last sync: ${lastSyncText}</div>

    <div class="navtabs">
      <button type="button" class="navtab active" data-view="snapshot">Snapshot</button>
      <button type="button" class="navtab" data-view="sources">Add lists</button>
      <button type="button" class="navtab" data-view="custom">Customize layout</button>
    </div>
  </div>

  <div class="grid">
    <div class="card snapshot">
      <h3>Current Snapshot</h3>
      <div class="rowtools">
        <button type="button" class="btn2" id="goAdd">➕ Add lists</button>
        <button type="button" id="goCustom">🎛 Customize layout</button>
      </div>
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
      <p class="mini muted" style="margin-top:8px;">Manifest version automatically bumps when catalogs, sorting, poster shapes or ordering change.</p>
    </div>

    <!-- Sources / Add lists -->
    <div class="card sources">
      <h3>Add lists</h3>
      <p class="mini muted">Add IMDb or Trakt sources, then click <b>Sync Lists Now</b> to pull them in.</p>

      <h4>Source pages</h4>
      <p class="mini muted">Examples: IMDb user lists page, Trakt user lists page.</p>
      <div class="row">
        <div>
          <input id="srcUsers" type="text" placeholder="One URL per line (IMDb/Trakt user lists pages)" />
        </div>
      </div>

      <h4>Explicit lists</h4>
      <p class="mini muted">Examples: <code class="code">https://www.imdb.com/list/lsXXXXXXXXX/</code>, <code class="code">lsXXXXXXXXX</code>, Trakt list URLs.</p>
      <div class="row">
        <div>
          <input id="srcLists" type="text" placeholder="One URL or ID per line (IMDb lists, charts, Trakt lists)" />
        </div>
      </div>

      <div class="rowtools">
        <button type="button" class="btn2" id="btnAddSources">💾 Save sources &amp; sync</button>
        <span class="statusText" id="sourcesStatus"></span>
      </div>

      <h4>Currently discovered sources</h4>
      <ul>${disc}</ul>
    </div>

    <!-- Customize layout -->
    <div class="card customize" id="customCard">
      <h3>Customize (enable, order, sort)</h3>
      <p class="mini muted">Use the checkboxes to enable lists, ↑ / ↓ to reorder, and choose a default sort. Click <b>Save</b> at the bottom.</p>

      <table>
        <thead>
          <tr>
            <th style="width:40px;">Enabled</th>
            <th>List (id)</th>
            <th style="width:70px;">Items</th>
            <th style="width:140px;">Default sort</th>
            <th style="width:90px;">Move</th>
            <th style="width:90px;">Remove</th>
          </tr>
        </thead>
        <tbody id="listsTbody">
          <!-- filled by JS -->
        </tbody>
      </table>

      <div style="margin-top:12px;">
        <button type="button" id="btnSavePrefs">💾 Save layout</button>
        <span class="statusText" id="prefsStatus"></span>
      </div>

      <hr style="margin:16px 0;border:0;border-top:1px solid var(--border);">

      <div id="listEditor">
        <p class="mini muted">Select a list above to edit its poster shape, custom order and items.</p>
      </div>
    </div>
  </div>
</div>

<script>
(function(){
  const ADMIN = ${JSON.stringify(ADMIN_PASSWORD)};
  const MANIFEST_URL = ${JSON.stringify(manifestUrl)};
  const ALL_SORTS = ${JSON.stringify(SORT_OPTIONS)};

  function qs(sel){ return document.querySelector(sel); }
  function qsa(sel){ return Array.from(document.querySelectorAll(sel)); }

  function escapeHtml(str){
    return String(str || "").replace(/[&<>"]/g,function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]);
    });
  }

  // ----- Tabs -----
  qsa('.navtab').forEach(function(btn){
    btn.addEventListener('click', function(){
      qsa('.navtab').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      var v = btn.getAttribute('data-view');
      document.body.className = 'view-' + v;
    });
  });

  var goAdd = qs('#goAdd');
  if (goAdd) {
    goAdd.addEventListener('click', function(){
      var btn = qsa('.navtab').find(function(b){return b.getAttribute('data-view')==='sources';});
      if (btn) btn.click();
    });
  }
  var goCustom = qs('#goCustom');
  if (goCustom) {
    goCustom.addEventListener('click', function(){
      var btn = qsa('.navtab').find(function(b){return b.getAttribute('data-view')==='custom';});
      if (btn) btn.click();
    });
  }

  // Install button
  var installBtn = qs('#installBtn');
  if (installBtn) {
    installBtn.addEventListener('click', function(){
      try {
        var target = 'stremio://' + encodeURIComponent(MANIFEST_URL);
        window.location.href = target;
      } catch(e) {
        alert('If this button does not work, copy the manifest URL into Stremio manually.');
      }
    });
  }

  // ----- API helpers -----
  function apiGet(path){
    var sep = path.indexOf('?') === -1 ? '?' : '&';
    return fetch(path + sep + 'admin=' + encodeURIComponent(ADMIN))
      .then(function(r){
        if (!r.ok) throw new Error('GET ' + path + ' -> ' + r.status);
        return r.json();
      });
  }
  function apiPost(path, body, expectJson){
    var sep = path.indexOf('?') === -1 ? '?' : '&';
    return fetch(path + sep + 'admin=' + encodeURIComponent(ADMIN), {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: body ? JSON.stringify(body) : '{}'
    }).then(function(r){
      if (!r.ok) return r.text().then(function(t){ throw new Error(t || ('HTTP ' + r.status)); });
      return expectJson ? r.json() : r.text();
    });
  }

  // ----- Global state -----
  var state = {
    lists:null,
    prefs:null,
    selected:null,
    currentItems:[],
    currentOrder:[]
  };

  function getOrderedIds(){
    if (!state.lists) return [];
    var allIds = Object.keys(state.lists);
    var enabledSet = new Set(
      state.prefs && state.prefs.enabled && state.prefs.enabled.length
        ? state.prefs.enabled
        : allIds
    );
    var base = Array.isArray(state.prefs && state.prefs.order)
      ? state.prefs.order.filter(function(id){ return state.lists[id]; })
      : [];
    var missing = allIds.filter(function(id){ return base.indexOf(id) === -1; })
      .sort(function(a,b){
        var na = (state.lists[a].name || a);
        var nb = (state.lists[b].name || b);
        return na.localeCompare(nb);
      });
    var ordered = base.concat(missing);
    return ordered.filter(function(id){ return enabledSet.has(id); });
  }

  function buildCustomizeTable(){
    var tbody = qs('#listsTbody');
    if (!tbody || !state.lists || !state.prefs) return;
    tbody.innerHTML = '';
    var ids = getOrderedIds();
    ids.forEach(function(lsid){
      var L = state.lists[lsid];
      var tr = document.createElement('tr');
      tr.setAttribute('data-lsid', lsid);

      // enabled
      var tdEn = document.createElement('td');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      var enabledList = state.prefs.enabled && state.prefs.enabled.length ? state.prefs.enabled : ids;
      cb.checked = enabledList.indexOf(lsid) !== -1;
      cb.addEventListener('change', function(){
        var set = new Set(state.prefs.enabled || []);
        if (cb.checked) set.add(lsid); else set.delete(lsid);
        state.prefs.enabled = Array.from(set);
      });
      tdEn.appendChild(cb);
      tr.appendChild(tdEn);

      // name
      var tdName = document.createElement('td');
      var titleDiv = document.createElement('div');
      titleDiv.innerHTML = '<b>' + escapeHtml(L.name || lsid) + '</b>';
      var idDiv = document.createElement('div');
      idDiv.className = 'mini muted';
      idDiv.textContent = lsid;
      tdName.appendChild(titleDiv);
      tdName.appendChild(idDiv);
      tr.appendChild(tdName);

      // items
      var tdItems = document.createElement('td');
      tdItems.textContent = (L.ids && L.ids.length) ? L.ids.length : 0;
      tr.appendChild(tdItems);

      // default sort
      var tdSort = document.createElement('td');
      var sel = document.createElement('select');
      ALL_SORTS.forEach(function(s){
        var opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        sel.appendChild(opt);
      });
      var cur = (state.prefs.perListSort && state.prefs.perListSort[lsid]) || 'name_asc';
      if (ALL_SORTS.indexOf(cur) === -1) cur = 'name_asc';
      sel.value = cur;
      sel.addEventListener('change', function(){
        state.prefs.perListSort = state.prefs.perListSort || {};
        state.prefs.perListSort[lsid] = sel.value;
      });
      tdSort.appendChild(sel);
      tr.appendChild(tdSort);

      // move buttons
      var tdMove = document.createElement('td');
      var upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'movebtn';
      upBtn.textContent = '↑';
      upBtn.addEventListener('click', function(e){
        e.stopPropagation();
        moveList(lsid, -1);
      });
      var dnBtn = document.createElement('button');
      dnBtn.type = 'button';
      dnBtn.className = 'movebtn';
      dnBtn.textContent = '↓';
      dnBtn.addEventListener('click', function(e){
        e.stopPropagation();
        moveList(lsid, 1);
      });
      tdMove.appendChild(upBtn);
      tdMove.appendChild(dnBtn);
      tr.appendChild(tdMove);

      // remove
      var tdRem = document.createElement('td');
      var rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.style.background = 'var(--danger)';
      rmBtn.textContent = 'Remove';
      rmBtn.addEventListener('click', function(e){
        e.stopPropagation();
        if (!confirm('Remove this list and block it from future discovery?')) return;
        apiPost('/api/remove-list', { lsid: lsid })
          .then(function(){
            qs('#prefsStatus').textContent = 'Removed ' + (L.name || lsid) + '.';
            loadState();
          })
          .catch(function(err){ alert(err.message || err); });
      });
      tdRem.appendChild(rmBtn);
      tr.appendChild(tdRem);

      // clicking row opens editor
      tr.addEventListener('click', function(e){
        // ignore clicks on buttons or inputs
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        openListEditor(lsid);
      });

      tbody.appendChild(tr);
    });

    // auto-select first list if none selected
    if (!state.selected && ids.length) openListEditor(ids[0]);
  }

  function moveList(lsid, dir){
    if (!state.prefs) return;
    var allIds = Object.keys(state.lists || {});
    var order = Array.isArray(state.prefs.order) && state.prefs.order.length
      ? state.prefs.order.slice()
      : allIds.slice();

    var idx = order.indexOf(lsid);
    if (idx === -1) return;
    var newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= order.length) return;

    var tmp = order[idx];
    order[idx] = order[newIdx];
    order[newIdx] = tmp;

    state.prefs.order = order;
    buildCustomizeTable();
  }

  // ----- List editor (items, custom order, shape) -----
  function openListEditor(lsid){
    if (!state.lists || !state.prefs) return;
    var L = state.lists[lsid];
    if (!L) return;
    state.selected = lsid;

    var editor = qs('#listEditor');
    editor.innerHTML = '';

    var heading = document.createElement('h4');
    heading.textContent = 'Edit list: ' + (L.name || lsid);
    editor.appendChild(heading);

    var info = document.createElement('div');
    info.className = 'mini muted';
    info.style.marginBottom = '8px';
    info.textContent = (L.url || '');
    editor.appendChild(info);

    // poster shape radios
    var shapeRow = document.createElement('div');
    shapeRow.className = 'rowtools';
    var span = document.createElement('span');
    span.className = 'mini muted';
    span.textContent = 'Poster shape in Stremio:';
    shapeRow.appendChild(span);

    var currentShape = (state.prefs.posterShape && state.prefs.posterShape[lsid]) || 'poster';
    ['poster','landscape'].forEach(function(mode){
      var lab = document.createElement('label');
      lab.className = 'pill';
      var rb = document.createElement('input');
      rb.type = 'radio';
      rb.name = 'shape_' + lsid;
      rb.value = mode;
      rb.checked = (mode === currentShape);
      rb.addEventListener('change', function(){
        state.prefs.posterShape = state.prefs.posterShape || {};
        state.prefs.posterShape[lsid] = mode;
      });
      lab.appendChild(rb);
      lab.appendChild(document.createTextNode(mode === 'poster' ? 'Poster (vertical)' : 'Landscape'));
      shapeRow.appendChild(lab);
    });
    editor.appendChild(shapeRow);

    // thumbs container
    var ul = document.createElement('ul');
    ul.id = 'thumbsGrid';
    ul.className = 'thumbs shape-' + currentShape;
    editor.appendChild(ul);

    // Add box
    var addLi = document.createElement('li');
    addLi.className = 'thumb add';
    var addBox = document.createElement('div');
    addBox.className = 'addbox';
    addBox.innerHTML = '<div class="mini muted">Add by IMDb ID (tt.... or URL)</div>';
    var addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.placeholder = 'tt1234567 or IMDb URL';
    addBox.appendChild(addInput);
    addLi.appendChild(addBox);
    ul.appendChild(addLi);

    function doAdd(){
      var val = (addInput.value || '').trim();
      if (!val) return;
      apiPost('/api/list-add', { lsid: lsid, id: val })
        .then(function(){
          addInput.value = '';
          refreshListItems(lsid, ul, addLi);
        })
        .catch(function(err){ alert(err.message || err); });
    }
    addInput.addEventListener('keydown', function(e){
      if (e.key === 'Enter') {
        e.preventDefault();
        doAdd();
      }
    });

    // buttons row
    var btnRow = document.createElement('div');
    btnRow.className = 'rowtools';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save order';
    var resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn2';
    resetBtn.textContent = 'Full reset';
    var status = document.createElement('span');
    status.className = 'statusText';
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(resetBtn);
    btnRow.appendChild(status);
    editor.appendChild(btnRow);

    saveBtn.addEventListener('click', function(){
      var order = state.currentOrder.slice();
      apiPost('/api/custom-order', { lsid: lsid, order: order }, true)
        .then(function(j){
          status.textContent = 'Saved custom order ✓ (rev ' + (j.manifestRev || '?') + ')';
        })
        .catch(function(err){
          status.textContent = 'Failed: ' + (err.message || err);
        });
    });

    resetBtn.addEventListener('click', function(){
      if (!confirm('Reset added/removed items and custom order for this list?')) return;
      apiPost('/api/list-reset', { lsid: lsid })
        .then(function(){
          status.textContent = 'List reset. Re-loading items…';
          refreshListItems(lsid, ul, addLi);
        })
        .catch(function(err){ status.textContent = 'Failed: ' + (err.message || err); });
    });

    refreshListItems(lsid, ul, addLi);
  }

  function refreshListItems(lsid, ul, addLi){
    state.currentItems = [];
    state.currentOrder = [];
    // clear all thumbs except add box
    Array.from(ul.querySelectorAll('.thumb')).forEach(function(el){
      if (el !== addLi) ul.removeChild(el);
    });
    apiGet('/api/list-items?lsid=' + encodeURIComponent(lsid))
      .then(function(j){
        var items = (j && j.items) || [];
        state.currentItems = items;
        state.currentOrder = items.map(function(it){ return it.id; });
        items.forEach(function(it){
          var li = document.createElement('li');
          li.className = 'thumb';
          li.setAttribute('draggable', 'true');
          li.setAttribute('data-id', it.id);

          var img = document.createElement('img');
          img.className = 'thumb-img';
          img.src = it.posterPortrait || it.poster || '';
          img.alt = it.name || it.id;
          li.appendChild(img);

          var txtBox = document.createElement('div');
          var tTitle = document.createElement('div');
          tTitle.className = 'title';
          tTitle.textContent = it.name || it.id;
          var tId = document.createElement('div');
          tId.className = 'id';
          tId.textContent = it.id;
          txtBox.appendChild(tTitle);
          txtBox.appendChild(tId);
          li.appendChild(txtBox);

          var del = document.createElement('div');
          del.className = 'del';
          del.textContent = '×';
          del.title = 'Remove from this list';
          del.addEventListener('click', function(e){
            e.stopPropagation();
            if (!confirm('Remove ' + (it.name || it.id) + ' from this list?')) return;
            apiPost('/api/list-remove', { lsid: lsid, id: it.id })
              .then(function(){
                refreshListItems(lsid, ul, addLi);
              })
              .catch(function(err){ alert(err.message || err); });
          });
          li.appendChild(del);

          ul.insertBefore(li, addLi);
        });

        setupDrag(ul, addLi);
      })
      .catch(function(err){
        console.error(err);
      });
  }

  function setupDrag(ul, addLi){
    var dragging = null;

    Array.from(ul.querySelectorAll('.thumb')).forEach(function(li){
      if (li === addLi) return;
      li.addEventListener('dragstart', function(e){
        dragging = li;
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      li.addEventListener('dragend', function(){
        if (dragging) dragging.classList.remove('dragging');
        dragging = null;
      });
    });

    ul.addEventListener('dragover', function(e){
      if (!dragging) return;
      e.preventDefault();
      var target = e.target.closest('.thumb');
      if (!target || target === dragging || target === addLi) return;
      var rect = target.getBoundingClientRect();
      var before = (e.clientY - rect.top) < rect.height / 2;
      if (before) ul.insertBefore(dragging, target);
      else ul.insertBefore(dragging, target.nextSibling);
      recomputeOrder(ul, addLi);
    });
  }

  function recomputeOrder(ul, addLi){
    var ids = [];
    Array.from(ul.querySelectorAll('.thumb')).forEach(function(li){
      if (li === addLi) return;
      var id = li.getAttribute('data-id');
      if (id) ids.push(id);
    });
    state.currentOrder = ids;
  }

  // ----- Save prefs (layout) -----
  var btnSavePrefs = qs('#btnSavePrefs');
  if (btnSavePrefs) {
    btnSavePrefs.addEventListener('click', function(){
      if (!state.prefs) return;
      var body = {
        enabled: state.prefs.enabled || [],
        order: state.prefs.order || [],
        defaultList: state.prefs.defaultList || '',
        perListSort: state.prefs.perListSort || {},
        sortOptions: state.prefs.sortOptions || {},
        posterShape: state.prefs.posterShape || {},
        upgradeEpisodes: !!state.prefs.upgradeEpisodes,
        sources: state.prefs.sources || { users: [], lists: [] },
        blocked: state.prefs.blocked || []
      };
      var status = qs('#prefsStatus');
      status.textContent = 'Saving…';
      apiPost('/api/prefs', body, false)
        .then(function(txt){
          status.textContent = 'Saved ✓ ' + txt;
        })
        .catch(function(err){
          status.textContent = 'Failed: ' + (err.message || err);
        });
    });
  }

  // ----- Add sources card -----
  var btnAddSources = qs('#btnAddSources');
  if (btnAddSources) {
    btnAddSources.addEventListener('click', function(){
      var usersRaw = (qs('#srcUsers').value || '').split(/\\n+/).map(function(s){return s.trim();}).filter(Boolean);
      var listsRaw = (qs('#srcLists').value || '').split(/\\n+/).map(function(s){return s.trim();}).filter(Boolean);
      var status = qs('#sourcesStatus');
      status.textContent = 'Saving & syncing…';
      apiPost('/api/add-sources', { users: usersRaw, lists: listsRaw }, false)
        .then(function(txt){
          status.textContent = 'Done ✓ ' + txt;
          loadState();
        })
        .catch(function(err){
          status.textContent = 'Failed: ' + (err.message || err);
        });
    });
  }

  // ----- Initial load -----
  function loadState(){
    Promise.all([ apiGet('/api/lists'), apiGet('/api/prefs') ])
      .then(function(res){
        state.lists = res[0];
        state.prefs = res[1];
        buildCustomizeTable();
      })
      .catch(function(err){
        console.error(err);
      });
  }

  loadState();
})();
</script>
</body></html>`);
});
 
// ----------------- BOOTSTRAP -----------------

(async () => {
  try {
    const snap = await loadSnapshot();
    if (snap) {
      LISTS = snap.lists || Object.create(null);
      PREFS = { ...PREFS, ...(snap.prefs || {}) };
      LAST_SYNC_AT = snap.lastSyncAt || 0;
      MANIFEST_REV = snap.manifestRev || MANIFEST_REV;
      if (snap.fallback) {
        for (const [k, v] of Object.entries(snap.fallback)) FALLBK.set(k, v);
      }
      if (snap.cards) {
        for (const [k, v] of Object.entries(snap.cards)) CARD.set(k, v);
      }
      if (snap.ep2ser) {
        for (const [k, v] of Object.entries(snap.ep2ser)) EP2SER.set(k, v);
      }
      LAST_MANIFEST_KEY = manifestKey();
      console.log(
        `[BOOT] Loaded snapshot with ${Object.keys(LISTS).length} lists.`
      );
    } else {
      console.log("[BOOT] No snapshot found, will run initial sync.");
      await fullSync({ rediscover: true });
    }
  } catch (e) {
    console.error("[BOOT] Error loading snapshot, running full sync:", e);
    await fullSync({ rediscover: true });
  }

  scheduleNextSync();

  app.listen(PORT, HOST, () => {
    console.log(
      `[BOOT] My Lists addon v12.4.1 listening on http://${HOST}:${PORT}`
    );
  });
})();
