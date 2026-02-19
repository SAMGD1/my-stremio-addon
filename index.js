/*  My Lists – IMDb → Stremio (custom per-list ordering, IMDb date order, sources & UI)
 *  v12.4.0 – Power user list management + TMDB verification
 */
"use strict";
const express = require("express");
const fs = require("fs/promises");

(function loadDotEnvLocal() {
  try {
    const raw = require("fs").readFileSync(".env", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      process.env[key] = val;
    }
  } catch {}
})();

// ----------------- ENV -----------------
const PORT  = Number(process.env.PORT || 7000);
const HOST  = "0.0.0.0";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SHARED_SECRET  = process.env.SHARED_SECRET  || "";

const IMDB_USER_URL     = process.env.IMDB_USER_URL || ""; // https://www.imdb.com/user/urXXXXXXX/lists/
const IMDB_SYNC_MINUTES = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));
const UPGRADE_EPISODES  = String(process.env.UPGRADE_EPISODES || "true").toLowerCase() !== "false";
const PRELOAD_CARDS = String(process.env.PRELOAD_CARDS || "true").toLowerCase() !== "false";
// fetch IMDb’s own release-date page order so our date sort matches IMDb exactly
const IMDB_FETCH_RELEASE_ORDERS = String(process.env.IMDB_FETCH_RELEASE_ORDERS || "true").toLowerCase() !== "false";

// Optional fallback: comma-separated ls ids
const IMDB_LIST_IDS = (process.env.IMDB_LIST_IDS || "")
  .split(/[,\s]+/).map(s => s.trim()).filter(s => /^ls\d{6,}$/i.test(s));

// Snapshot persistence
const SNAP_LOCAL    = "data/snapshot.json";
const FROZEN_DIR    = "data/frozen";
const BACKUP_DIR    = "data/backup";
const OFFLINE_DIR   = "data/manual";
const CUSTOM_DIR    = "data/custom";

// NEW: Trakt support (public API key / client id)
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID || "";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const SUPABASE_ENABLED = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

if (!SUPABASE_ENABLED) {
  console.log("[STORAGE] Supabase disabled (local-only mode)");
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/12.4.0";
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};
const CINEMETA = "https://v3-cinemeta.strem.io";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p";
const TMDB_CACHE_TTL = 1000 * 60 * 60 * 24;
const TMDB_CACHE_FAIL_TTL = 1000 * 60 * 5;
const IMDB_GRAPHQL_ENDPOINT = "https://caching.graphql.imdb.com/";
const IMDB_HASH_TITLE_LIST_MAIN_PAGE =
  "e3aac5739487b9f7f1398fb345dcef9b5a5baa48b71522fa514e77e41d6502e7";

// include "imdb" (raw list order) and mirror IMDb’s release-date order when available
const SORT_OPTIONS = [
  "custom","imdb","popularity",
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
  hiddenLists: [],        // listIds hidden from web UI and catalogs
  order: [],              // listIds order in manifest
  defaultList: "",
  perListSort: {},        // { listId: 'date_asc' | ... | 'custom' }
  sortReverse: {},        // { listId: true } => reverse default sort order
  sortOptions: {},        // { listId: ['custom', 'date_desc', ...] }
  customOrder: {},        // { listId: [ 'tt...', 'tt...' ] }
  upgradeEpisodes: UPGRADE_EPISODES,
  mainLists: [],
  tmdbKey: TMDB_API_KEY || "",
  tmdbKeyValid: null,
  displayNames: {},       // { listId: "Custom Name" }
  frozenLists: {},        // { listId: { ids:[], orders:{}, name, url, frozenAt, sortKey, sortReverse, customOrder } }
  customLists: {},        // { listId: { kind, sources, createdAt } }
  linkBackups: [],        // array of list URLs/IDs to keep as backup links
  backupConfigs: {},      // { listId: { id, name, url, sortKey, sortReverse, customOrder, main, savedAt } }
  sources: {              // extra sources you add in the UI
    users: [],            // array of IMDb user /lists URLs
    lists: [],            // array of list URLs (IMDb or Trakt) or lsids
    traktUsers: []        // array of Trakt user URLs or usernames
  },
  blocked: []             // listIds you removed/blocked (IMDb or Trakt)
};

const BEST   = new Map(); // Map<tt, { kind, meta }>
const FALLBK = new Map(); // Map<tt, { name?, poster?, releaseDate?, year?, type? }>
const EP2SER = new Map(); // Map<episode_tt, parent_series_tt>
const CARD   = new Map(); // Map<tt, card>
const TMDB_CACHE = new Map(); // Map<tt, { ts, rec, ok }>

let LAST_SYNC_AT = 0;
let syncTimer = null;
let syncInProgress = false;
let syncPromise = null;
let pendingForcedSync = false;

let MANIFEST_REV = 1;
let LAST_MANIFEST_KEY = "";

// ----------------- UTILS -----------------
const isImdb = v => /^tt\d{7,}$/i.test(String(v||""));

const isImdbListId = v => /^ls\d{6,}$/i.test(String(v||""));
const isImdbCustomId = v => /^imdb:[a-z0-9._-]+$/i.test(String(v||""));
const isTraktListId = v => /^trakt:[^:]+:[^:]+$/i.test(String(v||""));
const isCustomListId = v => /^custom:[a-z0-9._:-]+$/i.test(String(v||""));
const isListId = v => isImdbListId(v) || isTraktListId(v) || isImdbCustomId(v) || isCustomListId(v);
const isOfflineList = lsid => !!(PREFS.customLists && PREFS.customLists[lsid]?.kind === "offline");

function extractImdbId(value) {
  const m = String(value || "").match(/tt\d{7,}/i);
  return m ? m[0] : "";
}

function parseImdbCsv(text) {
  const lines = String(text || "").split(/\r?\n/);
  const ids = [];
  const seen = new Set();
  for (const line of lines) {
    const tt = extractImdbId(line);
    if (!tt || seen.has(tt)) continue;
    seen.add(tt);
    ids.push(tt);
  }
  return ids;
}

function appendUniqueIds(base, incoming) {
  const out = Array.isArray(base) ? base.slice() : [];
  const seen = new Set(out);
  for (const tt of incoming || []) {
    if (!isImdb(tt)) continue;
    if (seen.has(tt)) continue;
    seen.add(tt);
    out.push(tt);
  }
  return out;
}

function resolveStreamImdbId(rawId) {
  const base = extractImdbId(rawId);
  if (!base) return "";
  if (EP2SER && EP2SER.has(base)) return EP2SER.get(base);
  return base;
}

async function addImdbToList(lsid, imdbId) {
  if (!isListId(lsid)) return { ok: false, reason: "no_list" };
  const list = LISTS[lsid];
  if (!list) return { ok: false, reason: "missing" };
  if (isOfflineList(lsid)) {
    list.ids = appendUniqueIds(list.ids || [], [imdbId]);
    list.orders = list.orders || {};
    list.orders.imdb = list.ids.slice();
    await saveOfflineList(lsid);
    await getBestMeta(imdbId).catch(() => null);
    CARD.set(imdbId, cardFor(imdbId));
    await persistSnapshot();
    return { ok: true, lsid };
  }
  PREFS.listEdits = PREFS.listEdits || {};
  const edits = PREFS.listEdits[lsid] || { added: [], removed: [] };
  edits.added = Array.isArray(edits.added) ? edits.added : [];
  edits.removed = Array.isArray(edits.removed) ? edits.removed : [];

  const current = new Set(listIdsWithEdits(lsid));
  if (!current.has(imdbId)) {
    edits.added = edits.added.filter(id => id !== imdbId);
    edits.added.push(imdbId);
  }
  edits.removed = edits.removed.filter(id => id !== imdbId);
  PREFS.listEdits[lsid] = edits;
  syncFrozenEdits(lsid);

  await getBestMeta(imdbId).catch(() => null);
  CARD.set(imdbId, cardFor(imdbId));
  await persistSnapshot();
  return { ok: true, lsid };
}

async function removeImdbFromList(lsid, imdbId) {
  if (!isListId(lsid)) return { ok: false, reason: "no_list" };
  const list = LISTS[lsid];
  if (!list) return { ok: false, reason: "missing" };
  if (isOfflineList(lsid)) {
    list.ids = (list.ids || []).filter(id => id !== imdbId);
    list.orders = list.orders || {};
    list.orders.imdb = list.ids.slice();
    await saveOfflineList(lsid);
    await persistSnapshot();
    return { ok: true, lsid };
  }
  PREFS.listEdits = PREFS.listEdits || {};
  const edits = PREFS.listEdits[lsid] || { added: [], removed: [] };
  edits.added = Array.isArray(edits.added) ? edits.added : [];
  edits.removed = Array.isArray(edits.removed) ? edits.removed : [];

  edits.added = edits.added.filter(id => id !== imdbId);
  if (!edits.removed.includes(imdbId)) edits.removed.push(imdbId);
  PREFS.listEdits[lsid] = edits;
  syncFrozenEdits(lsid);

  await persistSnapshot();
  return { ok: true, lsid };
}

const TMDB_PLACEHOLDER_IMDB = "tt0111161";

function decodeHtmlEntities(str) {
  if (!str) return str;
  return String(str)
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
function sanitizeName(str) {
  return decodeHtmlEntities(str || "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function makeCustomListId(kind = "custom") {
  const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `custom:${kind}:${seed}`.toLowerCase();
}

function listDisplayName(lsid) {
  const override = PREFS.displayNames && PREFS.displayNames[lsid];
  if (override) return sanitizeName(override);
  return sanitizeName(LISTS[lsid]?.name || lsid);
}

function isFrozenList(lsid) {
  return !!(PREFS.frozenLists && PREFS.frozenLists[lsid]);
}

function frozenEntryFor(lsid, list) {
  return {
    ids: (list?.ids || []).slice(),
    orders: list?.orders || {},
    name: listDisplayName(lsid),
    url: list?.url,
    frozenAt: PREFS.frozenLists?.[lsid]?.frozenAt || Date.now(),
    sortKey: PREFS.perListSort?.[lsid] || "",
    sortReverse: !!(PREFS.sortReverse && PREFS.sortReverse[lsid]),
    customOrder: Array.isArray(PREFS.customOrder?.[lsid]) ? PREFS.customOrder[lsid].slice() : []
  };
}

function makeTraktListKey(user, slug) {
  return `trakt:${user}:${slug}`;
}
function parseTraktListKey(id) {
  const m = String(id || "").match(/^trakt:([^:]+):(.+)$/i);
  if (!m) return null;
  const slug = m[2];
  const watchlist = String(slug).toLowerCase() === "watchlist";
  return { user: m[1], slug, direct: m[1] === "list", watchlist };
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0; // force 32bit
  }
  return Math.abs(h);
}
function imdbCustomIdFor(url) {
  try {
    const u = new URL(url);
    const pathSlug = u.pathname.replace(/\/+/, '/').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'imdb';
    const qHash = hashString(u.search || '');
    return `imdb:${pathSlug}${qHash ? '-' + qHash.toString(36) : ''}`.toLowerCase();
  } catch {
    return `imdb:${hashString(String(url||''))}`;
  }
}
function base64Url(str) {
  return Buffer.from(String(str || ""), "utf8")
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function base64UrlDecode(str) {
  const norm = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}
function listFileName(lsid) {
  return `${String(lsid || "").trim()}.json`;
}
function frozenBackupPath(lsid) {
  return `${FROZEN_DIR}/${listFileName(lsid)}`;
}
function linkBackupPath(lsid) {
  return `${BACKUP_DIR}/${listFileName(lsid)}`;
}

const minutes = ms => Math.round(ms/60000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clampSortOptions = arr => (Array.isArray(arr) ? arr.filter(x => VALID_SORT.has(x)) : []);
let supabaseApiPromise = null;
const supabaseNoopApi = {
  putJSON: async () => {},
  getJSON: async () => null,
  deleteJSON: async () => {},
  listJSON: async () => []
};
const getSupabaseApi = async () => {
  if (!SUPABASE_ENABLED) return supabaseNoopApi;
  if (!supabaseApiPromise) supabaseApiPromise = import("./storage/supabase.mjs");
  return supabaseApiPromise;
};
let saveTimer = null;
let pendingSnapshot = null;

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
const imdbGraphqlHeaders = () => {
  const headers = {
    "accept": "application/graphql+json, application/json",
    "x-imdb-client-name": "imdb-web-next-localized",
    "user-agent": UA,
    "origin": "https://www.imdb.com",
    "referer": "https://www.imdb.com/"
  };
  return headers;
};

async function imdbGraphqlGet(operationName, variables, sha256Hash) {
  const params = new URLSearchParams();
  params.set("operationName", operationName);
  params.set("variables", JSON.stringify(variables));
  params.set("extensions", JSON.stringify({ persistedQuery: { sha256Hash, version: 1 } }));
  const url = `${IMDB_GRAPHQL_ENDPOINT}?${params.toString()}`;
  const r = await fetch(url, { method: "GET", headers: imdbGraphqlHeaders() });
  if (!r.ok) throw new Error(`IMDb GraphQL ${r.status}`);
  return r.json();
}

// ---- Supabase snapshot ----
const SNAPSHOT_PATH = "snapshot.json";
const MANUAL_INDEX_PATH = "manual/index.json";
const CUSTOM_INDEX_PATH = "custom/index.json";
const FROZEN_INDEX_PATH = "frozen/index.json";
const BACKUP_INDEX_PATH = "backup/index.json";

function offlineSafeName(lsid) {
  return String(lsid || "").replace(/[^a-z0-9._:-]+/gi, "_");
}
function offlineSupabasePath(lsid) {
  return `manual/${offlineSafeName(lsid)}.json`;
}
function customKindSafe(kind) {
  return String(kind || "custom").toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
}
function customListFileName(lsid) {
  return String(lsid || "").replace(/[^a-z0-9._:-]+/gi, "_") + ".json";
}
function customListDir(kind) {
  return `${CUSTOM_DIR}/${customKindSafe(kind)}`;
}
function customListFilePath(lsid, kind) {
  return `${customListDir(kind)}/${customListFileName(lsid)}`;
}
function customSupabasePath(lsid, kind) {
  return `custom/${customKindSafe(kind)}/${customListFileName(lsid)}`;
}
function isBackedCustomList(lsid) {
  const kind = PREFS.customLists?.[lsid]?.kind;
  return !!kind && kind !== "offline";
}
function frozenSupabasePath(lsid) {
  return `frozen/${listFileName(lsid)}`;
}
function linkBackupSupabasePath(lsid) {
  return `backup/${listFileName(lsid)}`;
}
function frozenSupabaseLegacyPath(lsid) {
  return `frozen/${base64Url(lsid)}.json`;
}
function linkBackupSupabaseLegacyPath(lsid) {
  return `backup/${base64Url(lsid)}.json`;
}

function scheduleSave(snapshot) {
  pendingSnapshot = snapshot;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = pendingSnapshot;
    pendingSnapshot = null;
    getSupabaseApi()
      .then(({ putJSON }) => putJSON(SNAPSHOT_PATH, data))
      .catch((err) => {
        if (SUPABASE_ENABLED) console.warn("[SNAPSHOT] supabase save failed:", err?.message || err);
      });
  }, 10000);
}

async function loadSupabaseIndex(path) {
  try {
    const { getJSON } = await getSupabaseApi();
    const data = await getJSON(path);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function saveSupabaseIndex(path, ids) {
  try {
    const { putJSON } = await getSupabaseApi();
    await putJSON(path, ids);
  } catch (e) {
    if (SUPABASE_ENABLED) console.warn("[SUPABASE] index save failed:", e?.message || e);
  }
}

async function addSupabaseIndexEntry(path, id) {
  const ids = await loadSupabaseIndex(path);
  if (!ids.includes(id)) {
    ids.push(id);
    await saveSupabaseIndex(path, ids);
  }
}

async function removeSupabaseIndexEntry(path, id) {
  const ids = await loadSupabaseIndex(path);
  const next = ids.filter(entry => entry !== id);
  if (next.length !== ids.length) {
    await saveSupabaseIndex(path, next);
  }
}

async function removeSupabaseFile(path, label) {
  try {
    const { deleteJSON } = await getSupabaseApi();
    await deleteJSON(path);
  } catch (e) {
    if (SUPABASE_ENABLED) console.warn(`[SUPABASE] ${label} delete failed:`, e?.message || e);
  }
}

async function saveSnapshot(obj) {
  // local (best effort)
  try {
    await fs.mkdir("data", { recursive: true });
    await fs.writeFile(SNAP_LOCAL, JSON.stringify(obj, null, 2), "utf8");
  } catch {/* ignore */}
  scheduleSave(obj);
}
async function loadSnapshot() {
  // try Supabase first
  try {
    const { getJSON } = await getSupabaseApi();
    const data = await getJSON(SNAPSHOT_PATH);
    if (data) return data;
  } catch {/* ignore */}
  // local
  try {
    const txt = await fs.readFile(SNAP_LOCAL, "utf8");
    return JSON.parse(txt);
  } catch { return null; }
}

function offlineFileName(lsid) {
  return `${OFFLINE_DIR}/${offlineSafeName(lsid)}.json`;
}

async function saveOfflineList(lsid) {
  if (!isOfflineList(lsid)) return;
  const list = LISTS[lsid];
  if (!list) return;
  try {
    await fs.mkdir(OFFLINE_DIR, { recursive: true });
    const payload = {
      id: lsid,
      name: sanitizeName(listDisplayName(lsid)),
      stremlist: Array.isArray(PREFS.mainLists) && PREFS.mainLists.includes(lsid),
      ids: Array.isArray(list.ids) ? list.ids : [],
      orders: list.orders || {},
      createdAt: PREFS.customLists?.[lsid]?.createdAt || Date.now(),
      updatedAt: Date.now()
    };
    await fs.writeFile(offlineFileName(lsid), JSON.stringify(payload, null, 2), "utf8");
    try {
      const { putJSON } = await getSupabaseApi();
      await putJSON(offlineSupabasePath(lsid), payload);
      await addSupabaseIndexEntry(MANUAL_INDEX_PATH, lsid);
    } catch (e) {
      if (SUPABASE_ENABLED) console.warn("[SUPABASE] manual list save failed:", e?.message || e);
    }
  } catch (e) {
    console.warn("[OFFLINE] save failed:", e.message || e);
  }
}

async function deleteOfflineListFile(lsid) {
  try {
    await fs.unlink(offlineFileName(lsid));
  } catch {/* ignore */}
  await removeSupabaseFile(offlineSupabasePath(lsid), "manual list");
  await removeSupabaseIndexEntry(MANUAL_INDEX_PATH, lsid);
}

async function loadOfflineLists() {
  try {
    const loaded = new Set();
    await fs.mkdir(OFFLINE_DIR, { recursive: true });
    const entries = await fs.readdir(OFFLINE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const txt = await fs.readFile(`${OFFLINE_DIR}/${entry.name}`, "utf8");
        const data = JSON.parse(txt);
        const id = String(data?.id || "").trim();
        if (!isCustomListId(id)) continue;
        loaded.add(id);
        const ids = Array.isArray(data.ids) ? data.ids.filter(isImdb) : [];
        const name = sanitizeName(data.name || id);
        const stremlist = !!data.stremlist;
        LISTS[id] = {
          id,
          name,
          url: null,
          ids: ids.slice(),
          orders: data.orders || { imdb: ids.slice() }
        };
        PREFS.customLists = PREFS.customLists || {};
        if (!PREFS.customLists[id]) {
          PREFS.customLists[id] = { kind: "offline", sources: ["offline"], createdAt: data.createdAt || Date.now() };
        } else {
          PREFS.customLists[id].kind = "offline";
        }
        PREFS.displayNames = PREFS.displayNames || {};
        if (name) PREFS.displayNames[id] = name;
        if (stremlist) {
          PREFS.mainLists = Array.isArray(PREFS.mainLists) ? PREFS.mainLists : [];
          if (!PREFS.mainLists.includes(id)) PREFS.mainLists.push(id);
        }
      } catch (e) {
        console.warn("[OFFLINE] load failed:", entry.name, e.message || e);
      }
    }
    let ids = await loadSupabaseIndex(MANUAL_INDEX_PATH);
    if (ids.length) {
      for (const id of ids) {
        if (!id || loaded.has(id) || !isCustomListId(id)) continue;
        try {
          const { getJSON } = await getSupabaseApi();
          const payload = await getJSON(offlineSupabasePath(id));
          if (!payload) continue;
          loaded.add(id);
          const listIds = Array.isArray(payload.ids) ? payload.ids.filter(isImdb) : [];
          const name = sanitizeName(payload.name || id);
          const stremlist = !!payload.stremlist;
          LISTS[id] = {
            id,
            name,
            url: null,
            ids: listIds.slice(),
            orders: payload.orders || { imdb: listIds.slice() }
          };
          PREFS.customLists = PREFS.customLists || {};
          if (!PREFS.customLists[id]) {
            PREFS.customLists[id] = { kind: "offline", sources: ["manual"], createdAt: payload.createdAt || Date.now() };
          } else {
            PREFS.customLists[id].kind = "offline";
          }
          PREFS.displayNames = PREFS.displayNames || {};
          if (name) PREFS.displayNames[id] = name;
          if (stremlist) {
            PREFS.mainLists = Array.isArray(PREFS.mainLists) ? PREFS.mainLists : [];
            if (!PREFS.mainLists.includes(id)) PREFS.mainLists.push(id);
          }
        } catch (e) {
          if (SUPABASE_ENABLED) console.warn("[SUPABASE] manual list load failed:", id, e?.message || e);
        }
      }
    } else {
      try {
        const { listJSON, getJSON } = await getSupabaseApi();
        const paths = await listJSON("manual");
        for (const path of paths) {
          const payload = await getJSON(path);
          const id = String(payload?.id || "").trim();
          if (!id || loaded.has(id) || !isCustomListId(id)) continue;
          loaded.add(id);
          const listIds = Array.isArray(payload.ids) ? payload.ids.filter(isImdb) : [];
          const name = sanitizeName(payload.name || id);
          const stremlist = !!payload.stremlist;
          LISTS[id] = {
            id,
            name,
            url: null,
            ids: listIds.slice(),
            orders: payload.orders || { imdb: listIds.slice() }
          };
          PREFS.customLists = PREFS.customLists || {};
          if (!PREFS.customLists[id]) {
            PREFS.customLists[id] = { kind: "offline", sources: ["manual"], createdAt: payload.createdAt || Date.now() };
          } else {
            PREFS.customLists[id].kind = "offline";
          }
          PREFS.displayNames = PREFS.displayNames || {};
          if (name) PREFS.displayNames[id] = name;
          if (stremlist) {
            PREFS.mainLists = Array.isArray(PREFS.mainLists) ? PREFS.mainLists : [];
            if (!PREFS.mainLists.includes(id)) PREFS.mainLists.push(id);
          }
        }
      } catch (e) {
        if (SUPABASE_ENABLED) console.warn("[SUPABASE] manual list listing failed:", e?.message || e);
      }
    }
  } catch (e) {
    console.warn("[OFFLINE] load directory failed:", e.message || e);
  }
}

async function reconcileFrozenBackups() {
  const desired = new Set(Object.keys(PREFS.frozenLists || {}));

  try {
    const files = await fs.readdir(FROZEN_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const txt = await fs.readFile(`${FROZEN_DIR}/${file}`, "utf8");
        const data = JSON.parse(txt);
        const id = String(data?.id || "").trim();
        if (id && desired.has(id)) continue;
      } catch {/* ignore */}
      try { await fs.unlink(`${FROZEN_DIR}/${file}`); } catch {/* ignore */}
    }
  } catch {/* ignore */}

  try {
    const { listJSON, getJSON, deleteJSON } = await getSupabaseApi();
    const paths = await listJSON("frozen");
    for (const path of paths) {
      let id = "";
      try {
        const parsed = await getJSON(path);
        id = String(parsed?.id || "").trim();
      } catch {/* ignore */}
      if (!id) {
        const file = path.split("/").pop() || "";
        if (file.endsWith(".json")) {
          try { id = base64UrlDecode(file.slice(0, -5)); } catch {/* ignore */}
        }
      }
      if (!id || desired.has(id)) continue;
      try { await deleteJSON(path); } catch (e) {
        if (SUPABASE_ENABLED) console.warn("[SUPABASE] frozen cleanup delete failed:", e?.message || e);
      }
    }
  } catch (e) {
    if (SUPABASE_ENABLED) console.warn("[SUPABASE] frozen cleanup list failed:", e?.message || e);
  }

  await saveSupabaseIndex(FROZEN_INDEX_PATH, Array.from(desired));
}

async function persistSnapshot() {
  await saveSnapshot({
    lastSyncAt: LAST_SYNC_AT,
    manifestRev: MANIFEST_REV,
    lists: LISTS,
    prefs: PREFS,
    fallback: Object.fromEntries(FALLBK),
    cards: Object.fromEntries(CARD),
    ep2ser: Object.fromEntries(EP2SER)
  });
  await persistFrozenBackups();
  await reconcileFrozenBackups();
  await persistLinkBackupConfigs();
}

async function saveCustomListBackup(lsid) {
  const meta = PREFS.customLists?.[lsid];
  if (!meta || meta.kind === "offline") return;
  const list = LISTS[lsid];
  if (!list) return;
  const kind = customKindSafe(meta.kind);
  await fs.mkdir(customListDir(kind), { recursive: true });
  const payload = {
    id: lsid,
    kind: meta.kind,
    sources: Array.isArray(meta.sources) ? meta.sources.slice() : [],
    createdAt: meta.createdAt || Date.now(),
    name: list.name || lsid,
    url: list.url || null,
    ids: Array.isArray(list.ids) ? list.ids.slice() : [],
    orders: list.orders || {},
    displayName: PREFS.displayNames?.[lsid] || "",
    savedAt: Date.now()
  };
  await fs.writeFile(customListFilePath(lsid, kind), JSON.stringify(payload, null, 2), "utf8");
  try {
    const { putJSON } = await getSupabaseApi();
    await putJSON(customSupabasePath(lsid, kind), payload);
  } catch (e) {
    if (SUPABASE_ENABLED) console.warn("[SUPABASE] custom list save failed:", e?.message || e);
  }
}

async function deleteCustomListBackup(lsid, kind = null) {
  const kinds = kind ? [kind] : ["merged", "duplicate", "custom"];
  await Promise.all(kinds.map(async (k) => {
    try { await fs.unlink(customListFilePath(lsid, k)); } catch {}
    await removeSupabaseFile(customSupabasePath(lsid, k), "custom list");
  }));
}

async function loadCustomLists() {
  const backedKinds = new Set(["merged", "duplicate"]);
  try {
    await fs.mkdir(CUSTOM_DIR, { recursive: true });
    const kindDirs = await fs.readdir(CUSTOM_DIR, { withFileTypes: true });
    for (const dir of kindDirs) {
      if (!dir.isDirectory()) continue;
      const kind = customKindSafe(dir.name);
      if (!backedKinds.has(kind)) continue;
      const base = `${CUSTOM_DIR}/${dir.name}`;
      const entries = await fs.readdir(base, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const txt = await fs.readFile(`${base}/${entry.name}`, 'utf8');
          const payload = JSON.parse(txt);
          const id = String(payload?.id || '').trim();
          if (!isCustomListId(id)) continue;
          if (LISTS[id]) continue;
          LISTS[id] = {
            id,
            name: sanitizeName(payload.name || id),
            url: payload.url || null,
            ids: Array.isArray(payload.ids) ? payload.ids.slice() : [],
            orders: payload.orders || {}
          };
          PREFS.customLists = PREFS.customLists || {};
          PREFS.customLists[id] = {
            kind: backedKinds.has(payload.kind) ? payload.kind : kind,
            sources: Array.isArray(payload.sources) ? payload.sources.slice() : [],
            createdAt: payload.createdAt || Date.now()
          };
          if (payload.displayName) {
            PREFS.displayNames = PREFS.displayNames || {};
            PREFS.displayNames[id] = sanitizeName(payload.displayName);
          }
        } catch {}
      }
    }
  } catch {}

  try {
    const ids = await loadSupabaseIndex(CUSTOM_INDEX_PATH);
    for (const raw of ids) {
      const id = String(raw || '').trim();
      if (!isCustomListId(id) || LISTS[id]) continue;
      const meta = PREFS.customLists?.[id];
      const kind = customKindSafe(meta?.kind || 'custom');
      if (!backedKinds.has(kind)) continue;
      try {
        const payload = await getJSON(customSupabasePath(id, kind));
        if (!payload || !Array.isArray(payload.ids)) continue;
        LISTS[id] = {
          id,
          name: sanitizeName(payload.name || id),
          url: payload.url || null,
          ids: payload.ids.slice(),
          orders: payload.orders || {}
        };
        PREFS.customLists = PREFS.customLists || {};
        PREFS.customLists[id] = {
          kind: backedKinds.has(payload.kind) ? payload.kind : kind,
          sources: Array.isArray(payload.sources) ? payload.sources.slice() : [],
          createdAt: payload.createdAt || Date.now()
        };
      } catch (e) {
        if (SUPABASE_ENABLED) console.warn('[SUPABASE] custom list load failed:', id, e?.message || e);
      }
    }
  } catch {}
}

async function saveCustomIndex() {
  const ids = Object.keys(PREFS.customLists || {}).filter(id => isBackedCustomList(id));
  try {
    const { putJSON } = await getSupabaseApi();
    await putJSON(CUSTOM_INDEX_PATH, ids);
  } catch (e) {
    if (SUPABASE_ENABLED) console.warn('[SUPABASE] custom index save failed:', e?.message || e);
  }
}

async function saveFrozenBackup(lsid, frozen) {
  const payload = {
    id: lsid,
    name: sanitizeName(frozen?.name || LISTS[lsid]?.name || listDisplayName(lsid)),
    displayName: listDisplayName(lsid),
    url: frozen?.url || LISTS[lsid]?.url,
    ids: Array.isArray(frozen?.ids) ? frozen.ids : [],
    orders: frozen?.orders || {},
    frozenAt: frozen?.frozenAt || Date.now(),
    sortKey: frozen?.sortKey || "",
    sortReverse: !!frozen?.sortReverse,
    customOrder: Array.isArray(frozen?.customOrder) ? frozen.customOrder : []
  };
  const path = frozenBackupPath(lsid);
  try {
    await fs.mkdir(FROZEN_DIR, { recursive: true });
    await fs.writeFile(path, JSON.stringify(payload, null, 2), "utf8");
  } catch {/* ignore */}
  try {
    const { putJSON, deleteJSON } = await getSupabaseApi();
    await putJSON(frozenSupabasePath(lsid), payload);
    const legacy = frozenSupabaseLegacyPath(lsid);
    if (legacy !== frozenSupabasePath(lsid)) {
      try { await deleteJSON(legacy); } catch {/* ignore */}
    }
  } catch (e) {
    console.warn("[SUPABASE] frozen backup save failed:", e?.message || e);
  }
}
async function deleteFrozenBackup(lsid) {
  const path = frozenBackupPath(lsid);
  try { await fs.unlink(path); } catch {/* ignore */}
  await removeSupabaseFile(frozenSupabasePath(lsid), "frozen backup");
  await removeSupabaseFile(frozenSupabaseLegacyPath(lsid), "frozen backup legacy");
}
async function persistFrozenBackups() {
  const frozen = PREFS.frozenLists || {};
  for (const [lsid, entry] of Object.entries(frozen)) {
    if (!entry.sortKey) entry.sortKey = PREFS.perListSort?.[lsid] || "name_asc";
    entry.sortReverse = !!(PREFS.sortReverse && PREFS.sortReverse[lsid]);
    if (!Array.isArray(entry.customOrder) || !entry.customOrder.length) {
      entry.customOrder = Array.isArray(PREFS.customOrder?.[lsid]) ? PREFS.customOrder[lsid].slice() : [];
    }
    await saveFrozenBackup(lsid, entry);
  }
}
async function saveLinkBackupConfig(lsid, config) {
  const payload = {
    id: lsid,
    name: sanitizeName(config?.name || LISTS[lsid]?.name || listDisplayName(lsid)),
    url: config?.url || LISTS[lsid]?.url,
    sortKey: config?.sortKey || "",
    sortReverse: !!config?.sortReverse,
    customOrder: Array.isArray(config?.customOrder) ? config.customOrder : [],
    main: !!config?.main,
    savedAt: config?.savedAt || Date.now()
  };
  const path = linkBackupPath(lsid);
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    await fs.writeFile(path, JSON.stringify(payload, null, 2), "utf8");
  } catch {/* ignore */}
  try {
    const { putJSON, deleteJSON } = await getSupabaseApi();
    await putJSON(linkBackupSupabasePath(lsid), payload);
    const legacy = linkBackupSupabaseLegacyPath(lsid);
    if (legacy !== linkBackupSupabasePath(lsid)) {
      try { await deleteJSON(legacy); } catch {/* ignore */}
    }
    await addSupabaseIndexEntry(BACKUP_INDEX_PATH, lsid);
  } catch (e) {
    console.warn("[SUPABASE] link backup save failed:", e?.message || e);
  }
}
async function deleteLinkBackupConfig(lsid) {
  const path = linkBackupPath(lsid);
  try { await fs.unlink(path); } catch {/* ignore */}
  await removeSupabaseFile(linkBackupSupabasePath(lsid), "link backup");
  await removeSupabaseFile(linkBackupSupabaseLegacyPath(lsid), "link backup legacy");
  await removeSupabaseIndexEntry(BACKUP_INDEX_PATH, lsid);
}
async function persistLinkBackupConfigs() {
  const configs = PREFS.backupConfigs || {};
  for (const [lsid, entry] of Object.entries(configs)) {
    entry.sortKey = PREFS.perListSort?.[lsid] || entry.sortKey || "name_asc";
    entry.sortReverse = !!(PREFS.sortReverse && PREFS.sortReverse[lsid]);
    entry.customOrder = Array.isArray(PREFS.customOrder?.[lsid]) ? PREFS.customOrder[lsid].slice() : (entry.customOrder || []);
    entry.main = Array.isArray(PREFS.mainLists) && PREFS.mainLists.includes(lsid);
    entry.savedAt = Date.now();
    await saveLinkBackupConfig(lsid, entry);
  }
}
async function loadLinkBackupConfigs() {
  const backups = new Map();
  try {
    const files = await fs.readdir(BACKUP_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const txt = await fs.readFile(`${BACKUP_DIR}/${file}`, "utf8");
        const data = JSON.parse(txt);
        if (data?.id) backups.set(String(data.id), data);
      } catch {/* ignore */}
    }
  } catch {/* ignore */}
  const ids = await loadSupabaseIndex(BACKUP_INDEX_PATH);
  if (ids.length) {
    for (const id of ids) {
      if (!id || backups.has(id)) continue;
      try {
        const { getJSON } = await getSupabaseApi();
        let parsed = null;
        try { parsed = await getJSON(linkBackupSupabasePath(id)); } catch {/* ignore */}
        if (!parsed) {
          try { parsed = await getJSON(linkBackupSupabaseLegacyPath(id)); } catch {/* ignore */}
        }
        if (parsed?.id) backups.set(String(parsed.id), parsed);
      } catch {/* ignore */}
    }
  } else {
    try {
      const { listJSON, getJSON } = await getSupabaseApi();
      const paths = await listJSON("backup");
      for (const path of paths) {
        const parsed = await getJSON(path);
        if (parsed?.id) backups.set(String(parsed.id), parsed);
      }
    } catch {/* ignore */}
  }
  return backups;
}
function restoreLinkBackupConfigEntry(lsid, data) {
  PREFS.backupConfigs = PREFS.backupConfigs || {};
  PREFS.backupConfigs[lsid] = {
    id: lsid,
    name: sanitizeName(data?.name || lsid),
    url: data?.url,
    sortKey: data?.sortKey || "",
    sortReverse: !!data?.sortReverse,
    customOrder: Array.isArray(data?.customOrder) ? data.customOrder.slice() : [],
    main: !!data?.main,
    savedAt: data?.savedAt || Date.now()
  };
  PREFS.linkBackups = Array.isArray(PREFS.linkBackups) ? PREFS.linkBackups : [];
  const backupValue = data?.url || lsid;
  if (backupValue && !PREFS.linkBackups.includes(backupValue)) PREFS.linkBackups.push(backupValue);
  if (data?.sortKey) {
    PREFS.perListSort = PREFS.perListSort || {};
    if (!PREFS.perListSort[lsid]) PREFS.perListSort[lsid] = data.sortKey;
  }
  if (data?.sortReverse) {
    PREFS.sortReverse = PREFS.sortReverse || {};
    if (!PREFS.sortReverse[lsid]) PREFS.sortReverse[lsid] = true;
  }
  if (Array.isArray(data?.customOrder) && data.customOrder.length) {
    PREFS.customOrder = PREFS.customOrder || {};
    if (!Array.isArray(PREFS.customOrder[lsid]) || !PREFS.customOrder[lsid].length) {
      PREFS.customOrder[lsid] = data.customOrder.slice();
    }
  }
  if (data?.main) {
    PREFS.mainLists = Array.isArray(PREFS.mainLists) ? PREFS.mainLists : [];
    if (!PREFS.mainLists.includes(lsid)) PREFS.mainLists.push(lsid);
  }
}
async function loadFrozenBackups() {
  const backups = new Map();
  try {
    const files = await fs.readdir(FROZEN_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const txt = await fs.readFile(`${FROZEN_DIR}/${file}`, "utf8");
        const data = JSON.parse(txt);
        if (data?.id) backups.set(String(data.id), data);
      } catch {/* ignore */}
    }
  } catch {/* ignore */}
  const ids = await loadSupabaseIndex(FROZEN_INDEX_PATH);
  if (ids.length) {
    for (const id of ids) {
      if (!id || backups.has(id)) continue;
      try {
        const { getJSON } = await getSupabaseApi();
        let parsed = null;
        try { parsed = await getJSON(frozenSupabasePath(id)); } catch {/* ignore */}
        if (!parsed) {
          try { parsed = await getJSON(frozenSupabaseLegacyPath(id)); } catch {/* ignore */}
        }
        if (parsed?.id) backups.set(String(parsed.id), parsed);
      } catch {/* ignore */}
    }
  } else {
    try {
      const { listJSON, getJSON } = await getSupabaseApi();
      const paths = await listJSON("frozen");
      for (const path of paths) {
        const parsed = await getJSON(path);
        if (parsed?.id) backups.set(String(parsed.id), parsed);
      }
    } catch {/* ignore */}
  }
  return backups;
}
function restoreFrozenBackupEntry(lsid, data) {
  PREFS.frozenLists = PREFS.frozenLists || {};
  const frozenName = sanitizeName(data?.name || data?.displayName || lsid);
  PREFS.frozenLists[lsid] = {
    ids: Array.isArray(data?.ids) ? data.ids.slice() : [],
    orders: data?.orders || {},
    name: frozenName,
    url: data?.url,
    frozenAt: data?.frozenAt || Date.now(),
    sortKey: data?.sortKey || "",
    sortReverse: !!data?.sortReverse,
    customOrder: Array.isArray(data?.customOrder) ? data.customOrder.slice() : []
  };
  PREFS.displayNames = PREFS.displayNames || {};
  if (frozenName) PREFS.displayNames[lsid] = frozenName;
  if (data?.sortKey) {
    PREFS.perListSort = PREFS.perListSort || {};
    if (!PREFS.perListSort[lsid]) PREFS.perListSort[lsid] = data.sortKey;
  }
  if (data?.sortReverse) {
    PREFS.sortReverse = PREFS.sortReverse || {};
    if (!PREFS.sortReverse[lsid]) PREFS.sortReverse[lsid] = true;
  }
  if (Array.isArray(data?.customOrder) && data.customOrder.length) {
    PREFS.customOrder = PREFS.customOrder || {};
    if (!Array.isArray(PREFS.customOrder[lsid]) || !PREFS.customOrder[lsid].length) {
      PREFS.customOrder[lsid] = data.customOrder.slice();
    }
  }
  if (!LISTS[lsid]) {
    LISTS[lsid] = {
      id: lsid,
      name: sanitizeName(data?.name || data?.displayName || lsid),
      url: data?.url || `https://www.imdb.com/list/${lsid}/`,
      ids: Array.isArray(data?.ids) ? data.ids.slice() : [],
      orders: data?.orders || { imdb: Array.isArray(data?.ids) ? data.ids.slice() : [] }
    };
  }
  PREFS.order = Array.isArray(PREFS.order) ? PREFS.order : [];
  if (!PREFS.order.includes(lsid)) PREFS.order.push(lsid);
  PREFS.enabled = Array.isArray(PREFS.enabled) ? PREFS.enabled : [];
  if (!PREFS.enabled.includes(lsid)) PREFS.enabled.push(lsid);
}

// ----------------- TRAKT HELPERS -----------------
function parseTraktListUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  const watchlist = s.match(/trakt\.tv\/users\/([^/]+)\/watchlist/i);
  if (watchlist) {
    const user = decodeURIComponent(watchlist[1]);
    return { user, slug: "watchlist", direct: false, watchlist: true };
  }

  const userList = s.match(/trakt\.tv\/users\/([^/]+)\/lists\/([^\/?#]+)/i);
  if (userList) {
    const user = decodeURIComponent(userList[1]);
    const slug = decodeURIComponent(userList[2]);
    return { user, slug, direct: false };
  }

  const official = s.match(/trakt\.tv\/lists\/official\/([^\/?#]+)/i);
  if (official) {
    const slug = decodeURIComponent(official[1]);
    return { user: "official", slug, direct: false };
  }

  const loose = s.match(/trakt\.tv\/lists\/([^\/?#]+)/i);
  if (loose) {
    const slug = decodeURIComponent(loose[1]);
    return { user: "list", slug, direct: true };
  }

  return null;
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

async function fetchTraktListMeta(info) {
  const { user, slug, direct } = info;
  try {
    if (info.watchlist) {
      return {
        name: "Watchlist",
        url: `https://trakt.tv/users/${user}/watchlist`
      };
    }
    const path = direct
      ? `/lists/${encodeURIComponent(slug)}`
      : `/users/${encodeURIComponent(user)}/lists/${encodeURIComponent(slug)}`;
    const data = await traktJson(path);
    if (!data) return null;
    const url = direct
      ? `https://trakt.tv/lists/${slug}`
      : `https://trakt.tv/users/${user}/lists/${slug}`;
    return {
      name: sanitizeName(data.name || `${user}/${slug}`),
      url
    };
  } catch (e) {
    console.warn("[TRAKT] list meta failed", user, slug, e.message);
    return null;
  }
}

async function fetchTraktWatchlistImdbIds(user) {
  const out = [];
  const seen = new Set();
  const types = [
    { key: "movies", prop: "movie" },
    { key: "shows", prop: "show" },
    { key: "seasons", prop: "season" },
    { key: "episodes", prop: "episode" }
  ];
  for (const { key, prop } of types) {
    let page = 1;
    while (true) {
      let items;
      try {
        items = await traktJson(`/users/${encodeURIComponent(user)}/watchlist/${key}?page=${page}&limit=100`);
      } catch (e) {
        console.warn("[TRAKT] watchlist fetch failed", user, key, e.message);
        break;
      }
      if (!Array.isArray(items) || !items.length) break;
      for (const it of items) {
        const obj = it[prop];
        const ids = obj && obj.ids;
        let imdb = ids && ids.imdb;
        if (!imdb && (key === "episodes" || key === "seasons") && it.show && it.show.ids && it.show.ids.imdb) {
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

async function fetchTraktListImdbIds(info) {
  if (info.watchlist) {
    return fetchTraktWatchlistImdbIds(info.user);
  }
  const { user, slug, direct } = info;
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
        const base = direct
          ? `/lists/${encodeURIComponent(slug)}`
          : `/users/${encodeURIComponent(user)}/lists/${encodeURIComponent(slug)}`;
        items = await traktJson(`${base}/items/${key}?page=${page}&limit=100`);
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

async function discoverTraktUserLists(user) {
  if (!TRAKT_CLIENT_ID) return [];
  const found = [];
  let page = 1;
  while (true) {
    let data;
    try {
      data = await traktJson(`/users/${encodeURIComponent(user)}/lists?page=${page}&limit=100`);
    } catch (e) {
      console.warn("[TRAKT] discover lists failed", user, e.message);
      break;
    }
    if (!Array.isArray(data) || !data.length) break;
    for (const it of data) {
      const slug = it?.ids?.slug || it?.name || it?.ids?.trakt;
      if (!slug) continue;
      const key = makeTraktListKey(user, slug);
      found.push({
        id: key,
        name: sanitizeName(it.name || `${user}/${slug}`),
        url: `https://trakt.tv/users/${user}/lists/${slug}`
      });
    }
    if (data.length < 100) break;
    page++;
    await sleep(60);
  }
  found.push({
    id: makeTraktListKey(user, "watchlist"),
    name: "Watchlist",
    url: `https://trakt.tv/users/${user}/watchlist`
  });
  return found;
}

// ----------------- IMDb DISCOVERY -----------------
function imdbUserIdFromUrl(value) {
  const m = String(value || "").match(/imdb\.com\/user\/(ur\d{6,})/i);
  return m ? m[1] : null;
}
function imdbWatchlistUrlForUser(userId) {
  return userId ? `https://www.imdb.com/user/${userId}/watchlist/` : "";
}
function isImdbWatchlistUrl(url) {
  return /imdb\.com\/user\/ur\d{6,}\/watchlist/i.test(String(url || ""));
}
function normalizeListIdOrUrl(s) {
  if (!s) return null;
  s = String(s).trim();
  if (isImdbWatchlistUrl(s)) {
    const url = s.startsWith("http") ? s : `https://www.imdb.com${s}`;
    return { id: imdbCustomIdFor(url), url };
  }
  const m = s.match(/ls\d{6,}/i);
  if (m) return { id: m[0], url: `https://www.imdb.com/list/${m[0]}/` };
  if (/imdb\.com\/list\//i.test(s)) return { id: null, url: s };
  if (/imdb\.com\/chart\//i.test(s) || /imdb\.com\/search\/title/i.test(s)) {
    const url = s.startsWith("http") ? s : `https://www.imdb.com${s}`;
    return { id: imdbCustomIdFor(url), url };
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
  const arr = Array.from(ids).map(id => ({ id, url: `https://www.imdb.com/list/${id}/` }));
  const imdbUserId = imdbUserIdFromUrl(userListsUrl);
  if (imdbUserId) {
    const watchUrl = imdbWatchlistUrlForUser(imdbUserId);
    if (watchUrl) {
      arr.push({ id: imdbCustomIdFor(watchUrl), url: watchUrl, watchlist: true });
    }
  }
  await Promise.all(arr.map(async L => {
    try { L.name = await fetchListName(L.url); }
    catch { L.name = L.watchlist ? "IMDb Watchlist" : L.id; }
  }));
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
    if (m) return sanitizeName(m[1].replace(/<[^>]+>/g," "));
  }
  const t = html.match(/<title>(.*?)<\/title>/i);
  return sanitizeName(t ? t[1].replace(/\s+\-\s*IMDb.*$/i,"") : listUrl);
}
function tconstsFromHtml(html) {
  const out = []; const seen = new Set(); let m;
  const re1 = /data-tconst=["'](tt\d{7,})["']/gi;
  while ((m = re1.exec(html))) if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  const re2 = /\/title\/(tt\d{7,})\//gi;
  while ((m = re2.exec(html))) if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  return out;
}

function extractImdbNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function findTitleListItemSearch(node) {
  if (!node || typeof node !== "object") return null;
  const direct = node?.mainColumnData?.predefinedList?.titleListItemSearch;
  if (direct?.edges) return direct;
  const seen = new Set();
  const walk = (obj) => {
    if (!obj || typeof obj !== "object") return null;
    if (seen.has(obj)) return null;
    seen.add(obj);
    if (typeof obj.total === "number" && obj.pageInfo && Array.isArray(obj.edges)) return obj;
    for (const v of Object.values(obj)) {
      const got = walk(v);
      if (got) return got;
    }
    return null;
  };
  return walk(node) || null;
}

function nextDataToTconsts(nextData) {
  const tls = findTitleListItemSearch(nextData?.props?.pageProps);
  if (!tls?.edges) return [];
  return tls.edges
    .map(e => e?.listItem?.id)
    .filter(id => typeof id === "string" && id.startsWith("tt"));
}

async function fetchImdbNextDataIds(listUrl) {
  const html = await fetchText(withParam(listUrl, "_", Date.now()));
  const nextData = extractImdbNextData(html);
  if (!nextData) return [];
  return nextDataToTconsts(nextData);
}

function toMobileImdbUrl(url) {
  try {
    const u = new URL(url);
    u.hostname = "m.imdb.com";
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    return u.toString();
  } catch {
    return url;
  }
}

function mobileHasNextPage(html) {
  return /aria-label=["']Next["']/.test(html) || />\s*Next\s*</i.test(html);
}

async function fetchImdbMobileIdsAllPages(listUrl, maxPages = 200) {
  const seen = new Set();
  const ids = [];
  const baseUrl = toMobileImdbUrl(listUrl);

  for (let page = 1; page <= maxPages; page++) {
    let url = withParam(baseUrl, "mode", "detail");
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
    if (!added && !mobileHasNextPage(html)) break;
    if (!mobileHasNextPage(html)) break;
    await sleep(120);
  }
  return ids;
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

// IMDb watchlist uses a different paging format; try a watchlist-tuned crawl.
async function fetchImdbWatchlistIdsAllPages(listUrl, maxPages = 80) {
  const graphIds = await fetchImdbWatchlistIdsGraphql(listUrl).catch(() => []);
  if (graphIds.length > 25) return graphIds;

  const nextDataIds = await fetchImdbNextDataIds(listUrl).catch(() => []);
  if (nextDataIds.length > 25) return nextDataIds;

  const mobileIds = await fetchImdbMobileIdsAllPages(listUrl, maxPages).catch(() => []);
  if (mobileIds.length > 25) return mobileIds;

  const crawlWithPage = async () => {
    const seen = new Set();
    const ids = [];
    for (let page = 1; page <= maxPages; page++) {
      let url = withParam(listUrl, "mode", "detail");
      url = withParam(url, "sort", "list_order,asc");
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
  };

  const crawlWithStart = async () => {
    const seen = new Set();
    const ids = [];
    for (let page = 0; page < maxPages; page++) {
      const start = 1 + page * 50;
      let url = withParam(listUrl, "mode", "detail");
      url = withParam(url, "sort", "list_order,asc");
      url = withParam(url, "start", String(start));
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
  };

  const pageIds = await crawlWithPage();
  if (pageIds.length > 25) return pageIds;
  const startIds = await crawlWithStart();
  return startIds.length ? startIds : pageIds;
}

async function fetchImdbWatchlistIdsGraphql(listUrl, { first = 250, maxPages = 1000, throttleMs = 200 } = {}) {
  const html = await fetchText(withParam(listUrl, "_", Date.now()));
  const listId = extractImdbListIdFromHtml(html);
  if (!listId) return [];
  return fetchImdbListIdsGraphql(listId, { first, maxPages, throttleMs });
}

function extractImdbListIdFromHtml(html) {
  const patterns = [
    /"listId"\s*:\s*"(ls\d{6,})"/i,
    /data-list-id=["'](ls\d{6,})["']/i,
    /\/list\/(ls\d{6,})\//i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return "";
}

async function fetchImdbListIdsGraphql(lsConst, {
  first = 250,
  locale = "en-US",
  sortBy = "LIST_ORDER",
  sortOrder = "ASC",
  throttleMs = 200,
  maxPages = 1000
} = {}) {
  let after = undefined;
  const seen = new Set();
  const ids = [];
  for (let page = 1; page <= maxPages; page++) {
    const variables = {
      first,
      locale,
      lsConst,
      sort: { by: sortBy, order: sortOrder },
      ...(after ? { after } : {})
    };
    const json = await imdbGraphqlGet("TitleListMainPage", variables, IMDB_HASH_TITLE_LIST_MAIN_PAGE);
    const edges = json?.data?.list?.titleListItemSearch?.edges ?? [];
    for (const e of edges) {
      const id = e?.listItem?.id;
      if (typeof id === "string" && id.startsWith("tt") && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    const pageInfo = json?.data?.list?.titleListItemSearch?.pageInfo ?? {};
    if (!pageInfo?.hasNextPage) break;
    after = pageInfo?.endCursor;
    if (!after) break;
    await sleep(throttleMs);
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

// generic IMDb page/search scraper with optional pagination via start=N
async function fetchImdbSearchOrPageIds(url, maxPages = 20) {
  const seen = new Set();
  const ids = [];
  const needsPaging = /imdb\.com\/search\//i.test(url) || /[?&]title_type=/i.test(url) || /[?&]start=/i.test(url);

  for (let page = 0; page < maxPages; page++) {
    const start = 1 + page * 50;
    const pageUrl = needsPaging ? withParam(url, "start", String(start)) : url;
    let html;
    try {
      html = await fetchText(withParam(pageUrl, "_", Date.now()));
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
    if (!added || !needsPaging) break;
    await sleep(80);
  }
  return ids;
}

// ----------------- METADATA -----------------
function getTmdbKey() {
  return String(PREFS.tmdbKey || TMDB_API_KEY || "").trim();
}
function isLikelyTmdbToken(key) {
  if (!key) return false;
  const text = String(key);
  return text.startsWith("eyJ") && text.split(".").length >= 2;
}
function tmdbEnabled() {
  const key = getTmdbKey();
  if (!key) return false;
  if (PREFS.tmdbKeyValid === false) return false;
  return true;
}
function tmdbImage(path, size = "w500") {
  if (!path) return null;
  return `${TMDB_IMG_BASE}/${size}${path}`;
}
function extractEpisodeInfo(ld) {
  try {
    const node = Array.isArray(ld && ld["@graph"])
      ? ld["@graph"].find(x => /TVEpisode/i.test(x["@type"])) || ld["@graph"][0]
      : ld;
    if (!node) return null;
    const ep = Number(node.episodeNumber || node.episode || node.partOfSeason?.episodeNumber);
    const season = Number(node.partOfSeason?.seasonNumber || node.seasonNumber);
    const part = node.partOfSeries || node.partOfTVSeries || (node.partOfSeason && node.partOfSeason.partOfSeries);
    const url = typeof part === "string" ? part : (part && (part.url || part.sameAs || part["@id"]));
    const m = url ? String(url).match(/tt\d{7,}/i) : null;
    if (!Number.isFinite(ep) || !Number.isFinite(season) || !m) return null;
    return { episode: ep, season, seriesImdb: m[0] };
  } catch {
    return null;
  }
}
function extractEpisodeInfoFromCinemeta(meta) {
  if (!meta) return null;
  const episode = Number(meta.episode);
  const season = Number(meta.season);
  const seriesId = meta.seriesId || meta.imdbSeriesId || meta.series_imdb_id || meta.seriesImdbId;
  const m = seriesId ? String(seriesId).match(/tt\d{7,}/i) : null;
  if (!Number.isFinite(episode) || !Number.isFinite(season) || !m) return null;
  return { episode, season, seriesImdb: m[0] };
}
function mergeMetaPrefer(base, override) {
  const out = { ...(base || {}) };
  if (!override) return out;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}
async function fetchTmdbJson(path, apiKey) {
  const useToken = isLikelyTmdbToken(apiKey);
  const url = useToken
    ? `${TMDB_BASE}${path}`
    : `${TMDB_BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(apiKey)}`;
  const headers = { "User-Agent": UA, "Accept": "application/json" };
  if (useToken) headers.Authorization = `Bearer ${apiKey}`;
  const r = await fetch(url, { headers, redirect: "follow" });
  if (r.status === 401 || r.status === 403) {
    PREFS.tmdbKeyValid = false;
    await saveSnapshot({
      lastSyncAt: LAST_SYNC_AT,
      manifestRev: MANIFEST_REV,
      lists: LISTS,
      prefs: PREFS,
      fallback: Object.fromEntries(FALLBK),
      cards: Object.fromEntries(CARD),
      ep2ser: Object.fromEntries(EP2SER)
    }).catch(() => {});
    throw new Error(`TMDB unauthorized (${r.status})`);
  }
  if (!r.ok) throw new Error(`TMDB ${path} -> ${r.status}`);
  try { return await r.json(); } catch { return null; }
}
async function fetchTmdbMeta(imdbId) {
  if (!tmdbEnabled()) return null;
  const cached = TMDB_CACHE.get(imdbId);
  const now = Date.now();
  if (cached && now - cached.ts < (cached.ok ? TMDB_CACHE_TTL : TMDB_CACHE_FAIL_TTL)) {
    return cached.rec;
  }
  const apiKey = getTmdbKey();
  try {
    const data = await fetchTmdbJson(`/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`, apiKey);
    const movie = data?.movie_results?.[0];
    const tv = data?.tv_results?.[0];
    const ep = data?.tv_episode_results?.[0];
    let rec = null;
    if (tv) {
      rec = {
        kind: "series",
        meta: {
          name: tv.name,
          poster: tmdbImage(tv.poster_path, "w500"),
          background: tmdbImage(tv.backdrop_path, "w780"),
          released: tv.first_air_date || undefined,
          year: tv.first_air_date ? Number(String(tv.first_air_date).slice(0, 4)) : undefined,
          description: tv.overview || undefined,
          imdbRating: tv.vote_average ? Number(tv.vote_average) : undefined
        }
      };
    } else if (movie) {
      rec = {
        kind: "movie",
        meta: {
          name: movie.title,
          poster: tmdbImage(movie.poster_path, "w500"),
          background: tmdbImage(movie.backdrop_path, "w780"),
          released: movie.release_date || undefined,
          year: movie.release_date ? Number(String(movie.release_date).slice(0, 4)) : undefined,
          description: movie.overview || undefined,
          imdbRating: movie.vote_average ? Number(movie.vote_average) : undefined
        }
      };
    } else if (ep) {
      rec = {
        kind: "series",
        meta: {
          name: ep.name || ep.show_name,
          poster: tmdbImage(ep.still_path, "w500"),
          background: tmdbImage(ep.still_path, "w780"),
          released: ep.air_date || undefined,
          year: ep.air_date ? Number(String(ep.air_date).slice(0, 4)) : undefined,
          description: ep.overview || undefined,
          imdbRating: ep.vote_average ? Number(ep.vote_average) : undefined
        }
      };
    }
    if (!rec) {
      const ld = await imdbJsonLd(imdbId);
      let epInfo = extractEpisodeInfo(ld);
      if (!epInfo) {
        const cineEpisode = await fetchCinemeta("series", imdbId);
        epInfo = extractEpisodeInfoFromCinemeta(cineEpisode);
      }
      if (epInfo) {
        const seriesFind = await fetchTmdbJson(`/find/${encodeURIComponent(epInfo.seriesImdb)}?external_source=imdb_id`, apiKey);
        const series = seriesFind?.tv_results?.[0];
        if (series?.id) {
          const epData = await fetchTmdbJson(`/tv/${series.id}/season/${epInfo.season}/episode/${epInfo.episode}`, apiKey);
          if (epData) {
            rec = {
              kind: "series",
              meta: {
                name: epData.name || epData.show_name,
                poster: tmdbImage(epData.still_path, "w500"),
                background: tmdbImage(epData.still_path, "w780"),
                released: epData.air_date || undefined,
                year: epData.air_date ? Number(String(epData.air_date).slice(0, 4)) : undefined,
                description: epData.overview || undefined,
                imdbRating: epData.vote_average ? Number(epData.vote_average) : undefined
              }
            };
          }
        }
      }
    }
    TMDB_CACHE.set(imdbId, { ts: now, rec, ok: !!rec });
    if (rec) PREFS.tmdbKeyValid = true;
    return rec;
  } catch (e) {
    TMDB_CACHE.set(imdbId, { ts: now, rec: null, ok: false });
    return null;
  }
}
function normalizeTitleSearchQuery(raw, forcedType = "all") {
  const text = String(raw || "").trim();
  const yearMatch = text.match(/(19\d{2}|20\d{2})/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  let cleaned = text.replace(/(19\d{2}|20\d{2})/g, " ");
  let inferredType = forcedType;
  if (forcedType === "all") {
    if (/(series|show|tv)/i.test(text)) inferredType = "tv";
    else if (/(movie|film)/i.test(text)) inferredType = "movie";
  }
  cleaned = cleaned.replace(/(series|show|tv|movie|film)/gi, " ").replace(/\s+/g, " ").trim();
  return { term: cleaned || text, year: Number.isFinite(year) ? year : null, mediaType: inferredType };
}

async function searchTmdbTitles(query, { limit = 5, mediaType = "all" } = {}) {
  if (!tmdbEnabled()) return [];
  const normalized = normalizeTitleSearchQuery(query, mediaType);
  const term = normalized.term;
  if (!term) return [];
  const apiKey = getTmdbKey();

  let pool = [];
  if (normalized.mediaType === "movie") {
    const yearParam = normalized.year ? `&year=${normalized.year}` : "";
    const search = await fetchTmdbJson(`/search/movie?query=${encodeURIComponent(term)}&include_adult=false&page=1${yearParam}`, apiKey);
    pool = Array.isArray(search?.results) ? search.results.map(x => ({ ...x, media_type: "movie" })) : [];
  } else if (normalized.mediaType === "tv") {
    const yearParam = normalized.year ? `&first_air_date_year=${normalized.year}` : "";
    const search = await fetchTmdbJson(`/search/tv?query=${encodeURIComponent(term)}&include_adult=false&page=1${yearParam}`, apiKey);
    pool = Array.isArray(search?.results) ? search.results.map(x => ({ ...x, media_type: "tv" })) : [];
  } else {
    const search = await fetchTmdbJson(`/search/multi?query=${encodeURIComponent(term)}&include_adult=false&page=1`, apiKey);
    pool = Array.isArray(search?.results)
      ? search.results.filter(x => x && (x.media_type === "movie" || x.media_type === "tv"))
      : [];
    if (normalized.year) {
      pool = pool.filter(item => {
        const d = item.media_type === "movie" ? item.release_date : item.first_air_date;
        const y = d ? Number(String(d).slice(0, 4)) : null;
        return Number.isFinite(y) && y === normalized.year;
      });
    }
  }

  const out = [];
  for (const item of pool) {
    if (out.length >= limit) break;
    const itemType = item.media_type;
    const tmdbId = Number(item.id);
    if (!Number.isFinite(tmdbId)) continue;

    let imdbId = "";
    try {
      const external = await fetchTmdbJson(`/${itemType}/${tmdbId}/external_ids`, apiKey);
      imdbId = extractImdbId(external?.imdb_id || "");
    } catch {
      imdbId = "";
    }

    const title = itemType === "movie"
      ? sanitizeName(item.title || item.original_title || "")
      : sanitizeName(item.name || item.original_name || "");
    const released = itemType === "movie" ? item.release_date : item.first_air_date;
    const year = released ? Number(String(released).slice(0, 4)) : null;
    out.push({
      tmdbId,
      mediaType: itemType,
      title,
      year: Number.isFinite(year) ? year : null,
      poster: tmdbImage(item.poster_path, "w342"),
      imdbId
    });
  }
  return out;
}

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
  const tmdbRec = await fetchTmdbMeta(imdbId);
  let meta = null;
  let kind = tmdbRec?.kind || null;

  const cineSeries = await fetchCinemeta("series", imdbId);
  const cineMovie = cineSeries ? null : await fetchCinemeta("movie", imdbId);

  if (tmdbRec && tmdbRec.meta) {
    const cine = cineSeries || cineMovie || null;
    meta = mergeMetaPrefer(cine, tmdbRec.meta);
    if (cine) {
      meta.imdbRating = meta.imdbRating ?? cine.imdbRating;
      meta.runtime = meta.runtime ?? cine.runtime;
      meta.year = meta.year ?? cine.year;
      meta.released = meta.released ?? cine.released;
      meta.poster = meta.poster ?? cine.poster;
      meta.background = meta.background ?? cine.background ?? cine.poster;
      if (!kind) kind = cineSeries ? "series" : "movie";
    }
  } else if (cineSeries) {
    meta = cineSeries;
    kind = "series";
  } else if (cineMovie) {
    meta = cineMovie;
    kind = "movie";
  }

  if (meta) {
    const rec = { kind: kind || "movie", meta };
    BEST.set(imdbId, rec);
    return rec;
  }
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
    name: sanitizeName(m.name || fb.name || imdbId),
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

function mergeListItems(sourceIds, sourceMap = LISTS) {
  const merged = [];
  const seen = new Set();
  (sourceIds || []).forEach(srcId => {
    const ids = sourceMap === LISTS ? listIdsWithEdits(srcId) : (sourceMap[srcId]?.ids || []);
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(id);
      }
    }
  });
  return merged;
}

async function fetchLiveListIds(lsid, sourceMap = LISTS, seen = new Set()) {
  if (!isListId(lsid) || seen.has(lsid)) return [];
  seen.add(lsid);
  const source = sourceMap[lsid] || LISTS[lsid];
  const customMeta = PREFS.customLists && PREFS.customLists[lsid];

  if (customMeta && (customMeta.kind === "merged" || customMeta.kind === "duplicate")) {
    const linkedSources = customMeta.kind === "duplicate"
      ? (Array.isArray(customMeta.sources) ? customMeta.sources.slice(0, 1) : [])
      : (customMeta.sources || []);
    const merged = [];
    const dedupe = new Set();
    for (const srcId of linkedSources) {
      const srcIds = await fetchLiveListIds(srcId, sourceMap, seen);
      for (const tt of srcIds) {
        if (!dedupe.has(tt)) {
          dedupe.add(tt);
          merged.push(tt);
        }
      }
    }
    return merged;
  }

  if (customMeta) return Array.isArray(source?.ids) ? source.ids.slice() : [];

  if (isTraktListId(lsid)) {
    const ts = parseTraktListKey(lsid);
    if (!ts || !TRAKT_CLIENT_ID) return [];
    try { return await fetchTraktListImdbIds(ts); }
    catch (e) { console.warn("[SYNC] Trakt fetch failed for", lsid, e.message); return []; }
  }

  const url = source?.url || `https://www.imdb.com/list/${lsid}/`;
  try {
    if (isImdbListId(lsid)) return await fetchImdbListIdsAllPages(url);
    if (isImdbWatchlistUrl(url)) return await fetchImdbWatchlistIdsAllPages(url);
    return await fetchImdbSearchOrPageIds(url);
  } catch (e) {
    console.warn("[SYNC] IMDb list fetch failed for", lsid, e.message);
    return [];
  }
}

// ----------------- SYNC -----------------
function manifestKey() {
  const enabled = (PREFS.enabled && PREFS.enabled.length) ? PREFS.enabled : Object.keys(LISTS);
  const names   = enabled.map(id => listDisplayName(id)).sort().join("|");
  const perSort = JSON.stringify(PREFS.perListSort || {});
  const perOpts = JSON.stringify(PREFS.sortOptions || {});
  const perReverse = JSON.stringify(PREFS.sortReverse || {});
  const custom  = Object.keys(PREFS.customOrder || {}).length;
  const order   = (PREFS.order || []).join(",");
  const frozen  = Object.keys(PREFS.frozenLists || {}).join(",");
  const customLists = Object.keys(PREFS.customLists || {}).join(",");
  const hidden = (PREFS.hiddenLists || []).join(",");

  const mainLists = JSON.stringify(PREFS.mainLists || []);
  return `${enabled.join(",")}#${order}#${PREFS.defaultList}#${mainLists}#${names}#${perSort}#${perOpts}#r${perReverse}#c${custom}#f${frozen}#u${customLists}#h${hidden}`;
}

async function harvestSources() {
  const blocked = new Set(PREFS.blocked || []);
  const map = new Map();

  const add = (d) => {
    if (!d || !d.id) return;
    if (blocked.has(d.id)) return;
    if (!d.name) d.name = d.id;
    d.name = sanitizeName(d.name);
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
  const backups = Array.isArray(PREFS.linkBackups) ? PREFS.linkBackups : [];
  const addlRaw = (PREFS.sources?.lists || []).concat(backups, IMDB_LIST_IDS || []);
  for (const raw of addlRaw) {
    const val = String(raw || "").trim();
    if (!val) continue;

    // ---- Trakt lists ----
    const tinfo = parseTraktListUrl(val);
      if (tinfo) {
        if (!TRAKT_CLIENT_ID) {
          console.warn("[TRAKT] got list", val, "but TRAKT_CLIENT_ID is not set – ignoring.");
          continue;
        }
        const key = makeTraktListKey(tinfo.user, tinfo.slug);
        if (blocked.has(key)) continue;

        let name = key;
        let metaUrl = tinfo.direct ? `https://trakt.tv/lists/${tinfo.slug}` : `https://trakt.tv/users/${tinfo.user}/lists/${tinfo.slug}`;
        try {
          const meta = await fetchTraktListMeta(tinfo);
          if (meta) {
            name = meta.name || name;
            if (meta.url) metaUrl = meta.url;
          }
        } catch (e) {
          console.warn("[TRAKT] meta fetch failed for", val, e.message);
        }

        add({
          id: key,
          url: metaUrl,
          name
        });
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
    if (!id) id = imdbCustomIdFor(url);
    let name = id;
    try { name = await fetchListName(url); }
    catch {
      if (isImdbWatchlistUrl(url)) name = "IMDb Watchlist";
    }

    add({ id, url, name });
    await sleep(60);
  }

  // 4) Trakt user discovery
  const traktUsers = Array.from(new Set((PREFS.sources?.traktUsers || []).map(s=>String(s).trim()).filter(Boolean)));
  for (const u of traktUsers) {
    const uname = (u.match(/trakt\.tv\/users\/([^/]+)/i)?.[1]) || u;
    if (!uname) continue;
    try {
      const arr = await discoverTraktUserLists(uname);
      arr.forEach(add);
    } catch (e) {
      console.warn("[DISCOVER] trakt user", uname, "failed:", e.message);
    }
    await sleep(80);
  }

  return Array.from(map.values());
}

async function fullSync({ rediscover = true, force = false } = {}) {
  if (syncInProgress) {
    if (force) pendingForcedSync = true;
    return syncPromise;
  }
  syncInProgress = true;
  const started = Date.now();
  syncPromise = (async () => {
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
        name: sanitizeName(d.name || d.id),
        url: d.url,
        ids: [],
        orders: d.orders || {}
      };
      seen.add(d.id);
    }
    const blocked = new Set(PREFS.blocked || []);
    for (const id of Object.keys(LISTS)) {
      const isCustom = isCustomListId(id);
      const hasCustomMeta = !!(PREFS.customLists && PREFS.customLists[id]);
      if (isCustom && !hasCustomMeta) continue;
      if (!seen.has(id) && !blocked.has(id)) next[id] = LISTS[id];
    }

    const customIds = Object.keys(PREFS.customLists || {});
    for (const id of customIds) {
      if (blocked.has(id)) continue;
      if (!next[id]) {
        const existing = LISTS[id] || {};
        next[id] = {
          id,
          name: sanitizeName(existing.name || PREFS.displayNames?.[id] || id),
          url: existing.url,
          ids: Array.isArray(existing.ids) ? existing.ids.slice() : [],
          orders: existing.orders || {}
        };
      }
      seen.add(id);
    }

    // pull items for each list (IMDb or Trakt)
    const uniques = new Set();
    for (const id of Object.keys(next)) {
      const list = next[id];
      const frozenSnapshot = PREFS.frozenLists && PREFS.frozenLists[id];
      const customMeta = PREFS.customLists && PREFS.customLists[id];

      if (frozenSnapshot) {
        list.ids = Array.isArray(frozenSnapshot.ids) ? frozenSnapshot.ids.slice() : list.ids || [];
        list.orders = frozenSnapshot.orders || list.orders || {};
        list.name = sanitizeName(frozenSnapshot.name || list.name || id);
        list.url = frozenSnapshot.url || list.url;
        list.ids.forEach(tt => uniques.add(tt));
        continue;
      }

      if (customMeta && (customMeta.kind === "merged" || customMeta.kind === "duplicate")) {
        const linkedSources = customMeta.kind === "duplicate"
          ? (Array.isArray(customMeta.sources) ? customMeta.sources.slice(0, 1) : [])
          : (customMeta.sources || []);
        const merged = [];
        const seenMerged = new Set();
        for (const srcId of linkedSources) {
          const srcIds = await fetchLiveListIds(srcId, next);
          for (const tt of srcIds) {
            if (!seenMerged.has(tt)) {
              seenMerged.add(tt);
              merged.push(tt);
            }
          }
        }
        list.ids = merged;
        list.orders = list.orders || {};
        list.orders.imdb = merged.slice();
        merged.forEach(tt => uniques.add(tt));
        continue;
      }

      if (customMeta) {
        list.ids = Array.isArray(list.ids) ? list.ids : [];
        list.ids.forEach(tt => uniques.add(tt));
        continue;
      }

      let raw = [];

      if (isTraktListId(id)) {
        const ts = parseTraktListKey(id);
        if (ts && TRAKT_CLIENT_ID) {
          try {
            raw = await fetchTraktListImdbIds(ts);
          } catch (e) {
            console.warn("[SYNC] Trakt fetch failed for", id, e.message);
          }
        }
      } else {
        const url = list.url || `https://www.imdb.com/list/${id}/`;
        try {
          if (isImdbListId(id)) {
            raw = await fetchImdbListIdsAllPages(url);
          } else if (isImdbWatchlistUrl(url)) {
            raw = await fetchImdbWatchlistIdsAllPages(url);
          } else {
            raw = await fetchImdbSearchOrPageIds(url);
          }
        } catch (e) {
          console.warn("[SYNC] IMDb list fetch failed for", id, e.message);
        }

        if (IMDB_FETCH_RELEASE_ORDERS && isImdbListId(id)) {
          try {
            const asc  = await fetchImdbOrder(url, "release_date,asc");
            const desc = await fetchImdbOrder(url, "release_date,desc");
            const pop  = await fetchImdbOrder(url, "moviemeter,asc");
            list.orders = list.orders || {};
            list.orders.date_asc  = asc.slice();
            list.orders.date_desc = desc.slice();
            list.orders.popularity = pop.slice();
            asc.forEach(tt => uniques.add(tt));
            desc.forEach(tt => uniques.add(tt));
            pop.forEach(tt => uniques.add(tt));
          } catch (e) {
            console.warn("[SYNC] extra IMDb sort fetch failed for", id, e.message);
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
        if (PREFS.frozenLists && PREFS.frozenLists[id]) {
          PREFS.frozenLists[id].ids = next[id].ids.slice();
          PREFS.frozenLists[id].orders = next[id].orders;
          PREFS.frozenLists[id].sortKey = PREFS.perListSort?.[id] || PREFS.frozenLists[id].sortKey || "";
          PREFS.frozenLists[id].sortReverse = !!(PREFS.sortReverse && PREFS.sortReverse[id]);
          PREFS.frozenLists[id].customOrder = Array.isArray(PREFS.customOrder?.[id]) ? PREFS.customOrder[id].slice() : (PREFS.frozenLists[id].customOrder || []);
        }
      }
    } else {
      for (const id of Object.keys(next)) {
        next[id].orders = next[id].orders || {};
        next[id].orders.imdb = next[id].ids.slice();
      }
    }

    // preload cards
    if (PRELOAD_CARDS) {
      for (const tt of idsToPreload) {
        await getBestMeta(tt);
        CARD.set(tt, cardFor(tt));
      }
    } else {
      console.log("[SYNC] card preload skipped (PRELOAD_CARDS=false)");
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

    await persistSnapshot();

      console.log(`[SYNC] ok – ${Object.values(LISTS).reduce((n,L)=>n+(L.ids?.length||0),0)} items across ${Object.keys(LISTS).length} lists in ${minutes(Date.now()-started)} min`);
    } catch (e) {
      console.error("[SYNC] failed:", e);
    } finally {
      syncInProgress = false;
    }
  })();
  try {
    await syncPromise;
  } finally {
    syncPromise = null;
    if (pendingForcedSync) {
      pendingForcedSync = false;
      await fullSync({ rediscover: true });
    }
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

async function syncSingleList(lsid, { manual = false } = {}) {
  const list = LISTS[lsid];
  if (!list) throw new Error("List not found");

  const customMeta = PREFS.customLists && PREFS.customLists[lsid];
  let raw = [];
  let orders = list.orders || {};

  if (customMeta && (customMeta.kind === "merged" || customMeta.kind === "duplicate")) {
    const linkedSources = customMeta.kind === "duplicate"
      ? (Array.isArray(customMeta.sources) ? customMeta.sources.slice(0, 1) : [])
      : (customMeta.sources || []);
    const seenMerged = new Set();
    for (const srcId of linkedSources) {
      const srcIds = await fetchLiveListIds(srcId);
      for (const tt of srcIds) {
        if (!seenMerged.has(tt)) {
          seenMerged.add(tt);
          raw.push(tt);
        }
      }
    }
    orders = { ...orders, imdb: raw.slice() };
  } else if (customMeta) {
    throw new Error("Custom lists have no source to sync");
  } else if (isTraktListId(lsid)) {
    const ts = parseTraktListKey(lsid);
    if (!ts || !TRAKT_CLIENT_ID) throw new Error("Trakt not configured");
    raw = await fetchTraktListImdbIds(ts);
  } else {
    const url = list.url || `https://www.imdb.com/list/${lsid}/`;
    if (isImdbListId(lsid)) {
      raw = await fetchImdbListIdsAllPages(url);
    } else if (isImdbWatchlistUrl(url)) {
      raw = await fetchImdbWatchlistIdsAllPages(url);
    } else {
      raw = await fetchImdbSearchOrPageIds(url);
    }
    if (IMDB_FETCH_RELEASE_ORDERS && isImdbListId(lsid)) {
      const asc  = await fetchImdbOrder(url, "release_date,asc");
      const desc = await fetchImdbOrder(url, "release_date,desc");
      const pop  = await fetchImdbOrder(url, "moviemeter,asc");
      orders = { ...orders, date_asc: asc.slice(), date_desc: desc.slice(), popularity: pop.slice() };
    }
  }

  let idsToUse = raw.slice();
  if (PREFS.upgradeEpisodes) {
    const up = [];
    const seen = new Set();
    for (const tt of idsToUse) {
      const rec = await getBestMeta(tt);
      let fin = tt;
      if (!rec.meta) {
        const s = await episodeParentSeries(tt);
        if (s && isImdb(s)) fin = s;
      }
      if (!seen.has(fin)) { seen.add(fin); up.push(fin); }
    }
    idsToUse = up;
  }

  list.ids = idsToUse;
  list.orders = { ...orders, imdb: idsToUse.slice() };

  if (isFrozenList(lsid)) {
    PREFS.frozenLists[lsid] = frozenEntryFor(lsid, list);
    await saveFrozenBackup(lsid, PREFS.frozenLists[lsid]);
  }

  if (PRELOAD_CARDS) {
    for (const tt of idsToUse) {
      await getBestMeta(tt);
      CARD.set(tt, cardFor(tt));
    }
  }

  LAST_MANIFEST_KEY = "";
  MANIFEST_REV++;

  await persistSnapshot();

  return { ok: true, ids: idsToUse.length, manual };
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
const adminHomeUrl = (req) => `${absoluteBase(req)}/admin?admin=${encodeURIComponent(ADMIN_PASSWORD)}`;
const adminCustomizeUrl = (req) => `${absoluteBase(req)}/admin?admin=${encodeURIComponent(ADMIN_PASSWORD)}&view=customize&mode=normal`;

app.get("/health", (_,res)=>res.status(200).send("ok"));

// ------- Manifest -------
const baseManifest = {
  id: "org.mylists.snapshot",
  version: "12.4.0",
  name: "My Lists",
  description: "Your IMDb & Trakt lists as catalogs (cached).",
  resources: ["catalog","meta","stream"],
  types: ["my lists","movie","series"],
  idPrefixes: ["tt"],
  behaviorHints: {
    configurable: true,
    configurationRequired: false
  }
};

function getEnabledOrderedIds() {
  const allIds  = Object.keys(LISTS);
  const hidden = new Set(PREFS.hiddenLists || []);
  const enabled = new Set((PREFS.enabled && PREFS.enabled.length ? PREFS.enabled : allIds).filter(id => !hidden.has(id)));
  const base    = (PREFS.order && PREFS.order.length ? PREFS.order.filter(id => LISTS[id]) : []);
  const missing = allIds.filter(id => !base.includes(id))
    .sort((a,b)=>( listDisplayName(a).localeCompare(listDisplayName(b)) ));
  const ordered = base.concat(missing);
  return ordered.filter(id => enabled.has(id));
}
function catalogs(){
  const ids = getEnabledOrderedIds();
  return ids.map(lsid => ({
    type: "my lists",
    id: `list:${lsid}`,
    name: `${isFrozenList(lsid) ? "⭐" : "🗂"} ${listDisplayName(lsid)}`,
    extraSupported: ["search","skip","limit","sort","genre"],
    extra: [
      { name:"search" }, { name:"skip" }, { name:"limit" },
      {
        name:"sort",
        options: (PREFS.sortOptions && PREFS.sortOptions[lsid] && PREFS.sortOptions[lsid].length) ? PREFS.sortOptions[lsid] : SORT_OPTIONS,
        isRequired: false,
        default: (PREFS.perListSort && PREFS.perListSort[lsid]) || "name_asc"
      },
      {
        name:"genre",
        options: (PREFS.sortOptions && PREFS.sortOptions[lsid] && PREFS.sortOptions[lsid].length) ? PREFS.sortOptions[lsid] : SORT_OPTIONS
      }
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
  const dest = adminHomeUrl(req);

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

app.get("/webapp.webmanifest", (req, res) => {
  const base = absoluteBase(req);
  const start = adminHomeUrl(req);
  res.type("application/manifest+json").send(JSON.stringify({
    id: "/admin",
    name: "My Lists Admin",
    short_name: "My Lists",
    description: "Manage list ordering, sorting, and sources for your Stremio addon.",
    start_url: start,
    scope: `${base}/`,
    display: "standalone",
    background_color: "#050415",
    theme_color: "#2f2165",
    icons: [
      { src: `${base}/pwa-icon.svg`, sizes: "192x192", type: "image/svg+xml", purpose: "any" },
      { src: `${base}/pwa-icon.svg`, sizes: "512x512", type: "image/svg+xml", purpose: "any" }
    ]
  }, null, 2));
});

app.get("/pwa-icon.svg", (req, res) => {
  res.type("image/svg+xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2f2165"/>
      <stop offset="100%" stop-color="#6c5ce7"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <text x="256" y="292" text-anchor="middle" font-size="188" font-weight="700" fill="#ffffff" font-family="system-ui,Segoe UI,Arial">M</text>
</svg>`);
});

app.get("/sw.js", (req, res) => {
  res.type("application/javascript").send(`
const CACHE_NAME = 'my-lists-admin-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname === '/admin') {
    event.respondWith((async () => {
      try {
        const net = await fetch(event.request);
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, net.clone()).catch(() => {});
        return net;
      } catch {
        const cached = await caches.match(event.request);
        return cached || Response.error();
      }
    })());
  }
});
`);
});

// ------- Catalog -------
function parseExtra(extraStr, qObj){
  const p = new URLSearchParams(extraStr||"");
  const parsed = { ...Object.fromEntries(p.entries()), ...(qObj||{}) };
  if (parsed.genre && !parsed.sort) parsed.sort = parsed.genre;
  return parsed;
}
function listIdsWithEdits(lsid) {
  const list = LISTS[lsid];
  if (!list) return [];
  if (isOfflineList(lsid)) return (list.ids || []).slice();
  let ids = (list.ids || []).slice();
  const ed = (PREFS.listEdits && PREFS.listEdits[lsid]) || {};
  const removed = new Set((ed.removed || []).filter(isImdb));
  if (removed.size) ids = ids.filter(tt => !removed.has(tt));
  const toAdd = (ed.added || []).filter(isImdb);
  for (const tt of toAdd) if (!ids.includes(tt)) ids.push(tt);
  return ids;
}

function syncFrozenEdits(lsid) {
  if (!PREFS.frozenLists || !PREFS.frozenLists[lsid]) return;
  const ids = listIdsWithEdits(lsid);
  PREFS.frozenLists[lsid].ids = ids.slice();
  const orders = PREFS.frozenLists[lsid].orders || {};
  orders.imdb = ids.slice();
  PREFS.frozenLists[lsid].orders = orders;
}

async function rebuildAllCards() {
  const unique = new Set();
  for (const id of Object.keys(LISTS)) {
    listIdsWithEdits(id).forEach(tt => unique.add(tt));
  }
  BEST.clear();
  FALLBK.clear();
  CARD.clear();
  for (const tt of unique) {
    await getBestMeta(tt);
    CARD.set(tt, cardFor(tt));
  }
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
    let ids = listIdsWithEdits(lsid);

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

    if (PREFS.sortReverse && PREFS.sortReverse[lsid]) metas = metas.slice().reverse();

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
      if (tmdbEnabled()) {
        const tmdbRec = await fetchTmdbMeta(imdbId);
        if (tmdbRec && tmdbRec.meta) {
          const nextMeta = mergeMetaPrefer(rec?.meta || {}, tmdbRec.meta);
          rec = { kind: tmdbRec.kind || rec?.kind || "movie", meta: nextMeta };
          BEST.set(imdbId, rec);
          CARD.set(imdbId, cardFor(imdbId));
        }
      }
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

// ------- Stream -------
app.get("/stream/:type/:id.json", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();
    const imdbId = resolveStreamImdbId(req.params.id);
    if (!imdbId) return res.json({ streams: [] });

    const mainLists = Array.isArray(PREFS.mainLists) ? PREFS.mainLists.filter(isListId) : [];
    if (!mainLists.length) {
      return res.json({
        streams: [{
          title: "You have not selected any Stremlist.",
          externalUrl: `stremio://detail/${encodeURIComponent(req.params.type)}/${imdbId}`
        }, {
          title: "🌐 Streamlist a list (open Customize Layout)",
          externalUrl: adminCustomizeUrl(req)
        }]
      });
    }

    const keyParam = SHARED_SECRET ? `?key=${encodeURIComponent(SHARED_SECRET)}` : "";
    const streams = [];
    for (const lsid of mainLists) {
      const listName = listDisplayName(lsid);
      const inList = listIdsWithEdits(lsid).includes(imdbId);
      const action = inList ? "Remove" : "Save";
      const symbol = inList ? "➖" : "➕";
      const path = inList ? "stream-remove" : "stream-add";
      const url = `${absoluteBase(req)}/${path}/${encodeURIComponent(req.params.type)}/${imdbId}?list=${encodeURIComponent(lsid)}${SHARED_SECRET ? `&key=${encodeURIComponent(SHARED_SECRET)}` : ""}`;
      streams.push({ title: `${symbol} ${action} this title ${inList ? "from" : "to"} ${listName}`, url });
    }
    streams.push({
      title: "🌐 Streamlist a list (open Customize Layout)",
      externalUrl: adminCustomizeUrl(req)
    });
    return res.json({ streams });
  } catch (e) {
    console.error("stream:", e);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/stream-add/:type/:id", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    const imdbId = resolveStreamImdbId(req.params.id);
    const lsid = String(req.query.list || "");
    if (imdbId) await addImdbToList(lsid, imdbId);
    res.redirect(`stremio://detail/${encodeURIComponent(req.params.type)}/${imdbId || ""}`);
  } catch (e) {
    console.error("stream-add:", e);
    res.status(500).send("Internal Server Error");
  }
});

app.get("/stream-remove/:type/:id", async (req, res) => {
  try {
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    const imdbId = resolveStreamImdbId(req.params.id);
    const lsid = String(req.query.list || "");
    if (imdbId) await removeImdbFromList(lsid, imdbId);
    res.redirect(`stremio://detail/${encodeURIComponent(req.params.type)}/${imdbId || ""}`);
  } catch (e) {
    console.error("stream-remove:", e);
    res.status(500).send("Internal Server Error");
  }
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
    PREFS.hiddenLists     = Array.isArray(body.hiddenLists) ? body.hiddenLists.filter(isListId) : (PREFS.hiddenLists || []);
    const hiddenSet = new Set(PREFS.hiddenLists);
    PREFS.enabled = PREFS.enabled.filter(id => !hiddenSet.has(id));
    PREFS.order           = Array.isArray(body.order)   ? body.order.filter(isListId)   : [];
    PREFS.defaultList     = isListId(body.defaultList) ? body.defaultList : "";
    PREFS.mainLists       = Array.isArray(body.mainLists)
      ? body.mainLists.filter(isListId)
      : (PREFS.mainLists || []);
    PREFS.perListSort     = body.perListSort && typeof body.perListSort === "object" ? body.perListSort : (PREFS.perListSort || {});
    PREFS.sortReverse     = body.sortReverse && typeof body.sortReverse === "object"
      ? Object.fromEntries(Object.entries(body.sortReverse).map(([k,v]) => [k, !!v]))
      : (PREFS.sortReverse || {});
    PREFS.sortOptions     = body.sortOptions && typeof body.sortOptions === "object"
      ? Object.fromEntries(Object.entries(body.sortOptions).map(([k,v])=>[k,clampSortOptions(v)]))
      : (PREFS.sortOptions || {});

    PREFS.upgradeEpisodes = !!body.upgradeEpisodes;
    if (typeof body.tmdbKey === "string") {
      PREFS.tmdbKey = body.tmdbKey.trim();
      if (!PREFS.tmdbKey) PREFS.tmdbKeyValid = null;
    }

    if (body.customOrder && typeof body.customOrder === "object") {
      PREFS.customOrder = body.customOrder;
    }

    const src = body.sources || {};
    PREFS.sources = {
      users: Array.isArray(src.users) ? src.users.map(s=>String(s).trim()).filter(Boolean) : (PREFS.sources.users || []),
      lists: Array.isArray(src.lists) ? src.lists.map(s=>String(s).trim()).filter(Boolean) : (PREFS.sources.lists || []),
      traktUsers: Array.isArray(src.traktUsers) ? src.traktUsers.map(s=>String(s).trim()).filter(Boolean) : (PREFS.sources.traktUsers || [])
    };

    PREFS.blocked = Array.isArray(body.blocked) ? body.blocked.filter(isListId) : (PREFS.blocked || []);
    if (!Array.isArray(body.mainLists) && isListId(body.mainList)) {
      PREFS.mainLists = [body.mainList];
    }

    if (PREFS.customLists) {
      const offlineIds = Object.keys(PREFS.customLists).filter(isOfflineList);
      await Promise.all(offlineIds.map(id => saveOfflineList(id)));
      const customIds = Object.keys(PREFS.customLists).filter(id => isBackedCustomList(id));
      await Promise.all(customIds.map(id => saveCustomListBackup(id)));
      await saveCustomIndex();
    }

    const key = manifestKey();
    if (key !== LAST_MANIFEST_KEY) { LAST_MANIFEST_KEY = key; MANIFEST_REV++; }

    await persistSnapshot();

    res.status(200).send("Saved. Manifest rev " + MANIFEST_REV);
  }catch(e){ console.error("prefs save error:", e); res.status(500).send("Failed to save"); }
});

app.post("/api/tmdb-verify", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const key = String(req.body.key || "").trim();
    if (!key) return res.status(400).send("Missing TMDB key");
    PREFS.tmdbKey = key;
    PREFS.tmdbKeyValid = null;
    TMDB_CACHE.clear();
    const rec = await fetchTmdbMeta(TMDB_PLACEHOLDER_IMDB);
    if (rec && rec.meta) {
      PREFS.tmdbKeyValid = true;
      await rebuildAllCards();
      LAST_MANIFEST_KEY = "";
      MANIFEST_REV++;
      await persistSnapshot();
      return res.json({ ok: true, message: "TMDB key verified and in use." });
    }
    PREFS.tmdbKeyValid = false;
    await persistSnapshot();
    return res.status(400).json({ ok: false, message: "TMDB key is invalid or not authorized." });
  } catch (e) {
    PREFS.tmdbKeyValid = false;
    await persistSnapshot();
    res.status(500).json({ ok: false, message: e.message || "TMDB verification failed." });
  }
});

app.post("/api/tmdb-save", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const key = String(req.body.key || "").trim();
    PREFS.tmdbKey = key;
    PREFS.tmdbKeyValid = key ? PREFS.tmdbKeyValid : null;
    TMDB_CACHE.clear();
    if (!key) {
      BEST.clear();
      CARD.clear();
      LAST_MANIFEST_KEY = "";
      MANIFEST_REV++;
    }
    await persistSnapshot();
    res.json({ ok: true });
  } catch (e) { res.status(500).send("TMDB save failed"); }
});

app.post("/api/list-rename", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lsid = String(req.body.lsid || "");
    const name = sanitizeName(req.body.name || "");
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    PREFS.displayNames = PREFS.displayNames || {};
    if (name) PREFS.displayNames[lsid] = name;
    else delete PREFS.displayNames[lsid];
    if (isOfflineList(lsid) && LISTS[lsid]) {
      LISTS[lsid].name = name || LISTS[lsid].name;
      await saveOfflineList(lsid);
    }
    LAST_MANIFEST_KEY = ""; MANIFEST_REV++;
    await persistSnapshot();
    res.json({ ok: true, name });
  } catch (e) { res.status(500).send("Rename failed"); }
});

app.post("/api/list-freeze", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lsid = String(req.body.lsid || "");
    const frozen = !!req.body.frozen;
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    if (isOfflineList(lsid)) return res.status(400).send("Offline lists cannot be frozen");
    PREFS.frozenLists = PREFS.frozenLists || {};
    if (frozen) {
      const list = LISTS[lsid];
      if (!list) return res.status(404).send("List not found");
      PREFS.frozenLists[lsid] = frozenEntryFor(lsid, list);
      await saveFrozenBackup(lsid, PREFS.frozenLists[lsid]);
    } else {
      delete PREFS.frozenLists[lsid];
      await deleteFrozenBackup(lsid);
    }
    LAST_MANIFEST_KEY = ""; MANIFEST_REV++;
    await persistSnapshot();
    res.json({ ok: true, frozen });
  } catch (e) { res.status(500).send("Freeze failed"); }
});

app.post("/api/list-duplicate", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lsid = String(req.body.lsid || "");
    const name = sanitizeName(req.body.name || "");
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    const source = LISTS[lsid];
    if (!source) return res.status(404).send("List not found");
    const ids = listIdsWithEdits(lsid);
    const isOffline = isOfflineList(lsid);
    const newId = makeCustomListId(isOffline ? "offline" : "duplicate");
    LISTS[newId] = {
      id: newId,
      name: name || `Copy of ${listDisplayName(lsid)}`,
      url: null,
      ids: ids.slice(),
      orders: { imdb: ids.slice() }
    };
    PREFS.customLists = PREFS.customLists || {};
    PREFS.customLists[newId] = { kind: isOffline ? "offline" : "duplicate", sources: [lsid], createdAt: Date.now() };
    PREFS.displayNames = PREFS.displayNames || {};
    if (name) PREFS.displayNames[newId] = name;
    PREFS.order = Array.isArray(PREFS.order) ? PREFS.order.concat(newId) : [newId];
    PREFS.enabled = Array.isArray(PREFS.enabled) ? Array.from(new Set([ ...PREFS.enabled, newId ])) : [newId];
    LAST_MANIFEST_KEY = ""; MANIFEST_REV++;
    if (isOffline) await saveOfflineList(newId);
    else { await saveCustomListBackup(newId); await saveCustomIndex(); }
    await persistSnapshot();
    res.json({ ok: true, id: newId });
  } catch (e) { res.status(500).send("Duplicate failed"); }
});

app.post("/api/create-offline-list", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const name = sanitizeName(req.body.name || "");
    const idsFromBody = Array.isArray(req.body.ids) ? req.body.ids.filter(isImdb) : [];
    const csvText = String(req.body.csvText || "");
    const csvIds = csvText ? parseImdbCsv(csvText) : [];
    const ids = appendUniqueIds([], idsFromBody.concat(csvIds));
    if (!name) return res.status(400).send("Name required");
    const newId = makeCustomListId("offline");
    LISTS[newId] = {
      id: newId,
      name,
      url: null,
      ids: ids.slice(),
      orders: { imdb: ids.slice() }
    };
    PREFS.customLists = PREFS.customLists || {};
    PREFS.customLists[newId] = { kind: "offline", sources: ["manual"], createdAt: Date.now() };
    PREFS.displayNames = PREFS.displayNames || {};
    PREFS.displayNames[newId] = name;
    PREFS.order = Array.isArray(PREFS.order) ? PREFS.order.concat(newId) : [newId];
    PREFS.enabled = Array.isArray(PREFS.enabled) ? Array.from(new Set([ ...PREFS.enabled, newId ])) : [newId];
    for (const tt of ids) {
      await getBestMeta(tt).catch(() => null);
      CARD.set(tt, cardFor(tt));
    }
    await saveOfflineList(newId);
    LAST_MANIFEST_KEY = ""; MANIFEST_REV++;
    await persistSnapshot();
    res.json({ ok: true, id: newId });
  } catch (e) { res.status(500).send("Create offline list failed"); }
});

app.post("/api/list-import-csv", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lsid = String(req.body.lsid || "");
    const csvText = String(req.body.csvText || "");
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    if (!isOfflineList(lsid)) return res.status(400).send("CSV upload only for offline lists");
    const list = LISTS[lsid];
    if (!list) return res.status(404).send("List not found");
    const newIds = parseImdbCsv(csvText);
    list.ids = appendUniqueIds(list.ids || [], newIds);
    list.orders = list.orders || {};
    list.orders.imdb = list.ids.slice();
    for (const tt of newIds) {
      await getBestMeta(tt).catch(() => null);
      CARD.set(tt, cardFor(tt));
    }
    await saveOfflineList(lsid);
    LAST_MANIFEST_KEY = ""; MANIFEST_REV++;
    await persistSnapshot();
    res.json({ ok: true, added: newIds.length, total: list.ids.length });
  } catch (e) { res.status(500).send("CSV import failed"); }
});

app.post("/api/list-merge", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const sources = Array.isArray(req.body.sources) ? req.body.sources.filter(isListId) : [];
    const name = sanitizeName(req.body.name || "");
    if (!sources.length || sources.length > 4) return res.status(400).send("Select 1-4 lists to merge");
    const mergedId = makeCustomListId("merged");
    const ids = mergeListItems(sources);
    LISTS[mergedId] = {
      id: mergedId,
      name: name || `Merged: ${sources.map(id => listDisplayName(id)).join(" + ")}`,
      url: null,
      ids: ids.slice(),
      orders: { imdb: ids.slice() }
    };
    PREFS.customLists = PREFS.customLists || {};
    PREFS.customLists[mergedId] = { kind: "merged", sources: sources.slice(), createdAt: Date.now() };
    PREFS.displayNames = PREFS.displayNames || {};
    if (name) PREFS.displayNames[mergedId] = name;
    PREFS.order = Array.isArray(PREFS.order) ? PREFS.order.concat(mergedId) : [mergedId];
    PREFS.enabled = Array.isArray(PREFS.enabled) ? Array.from(new Set([ ...PREFS.enabled, mergedId ])) : [mergedId];
    await saveCustomListBackup(mergedId);
    await saveCustomIndex();
    LAST_MANIFEST_KEY = ""; MANIFEST_REV++;
    await persistSnapshot();
    res.json({ ok: true, id: mergedId });
  } catch (e) { res.status(500).send("Merge failed"); }
});

app.post("/api/list-manual-sync", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lsid = String(req.body.lsid || "");
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    const result = await syncSingleList(lsid, { manual: true });
    res.json(result);
  } catch (e) { res.status(500).send(e.message || "Manual sync failed"); }
});

app.post("/api/delete-custom-list", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lsid = String(req.body.lsid || "");
    if (!isCustomListId(lsid)) return res.status(400).send("Invalid lsid");
    delete LISTS[lsid];
    if (PREFS.customLists) delete PREFS.customLists[lsid];
    if (PREFS.displayNames) delete PREFS.displayNames[lsid];
    if (PREFS.frozenLists) delete PREFS.frozenLists[lsid];
    if (PREFS.listEdits) delete PREFS.listEdits[lsid];
    if (PREFS.customOrder) delete PREFS.customOrder[lsid];
    if (PREFS.perListSort) delete PREFS.perListSort[lsid];
    if (PREFS.sortOptions) delete PREFS.sortOptions[lsid];
    if (PREFS.sortReverse) delete PREFS.sortReverse[lsid];
    if (Array.isArray(PREFS.mainLists)) {
      PREFS.mainLists = PREFS.mainLists.filter(id => id !== lsid);
    }
    if (PREFS.blocked) PREFS.blocked = PREFS.blocked.filter(id => id !== lsid);
    PREFS.enabled = (PREFS.enabled || []).filter(id => id !== lsid);
    PREFS.order = (PREFS.order || []).filter(id => id !== lsid);
    await deleteFrozenBackup(lsid);
    await deleteOfflineListFile(lsid);
    await deleteCustomListBackup(lsid);
    await saveCustomIndex();
    LAST_MANIFEST_KEY = ""; MANIFEST_REV++;
    await persistSnapshot();
    res.json({ ok: true });
  } catch (e) { res.status(500).send("Delete failed"); }
});

app.get("/api/discovered", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lists = await harvestSources();
    res.json({ lists });
  } catch (e) {
    res.status(500).json({ lists: [], error: e.message });
  }
});

app.post("/api/bulk-add-sources", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const usersText = String(req.body.usersText || "");
    const listsText = String(req.body.listsText || "");
    const lines = (str) => str.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const userLines = lines(usersText);
    const listLines = lines(listsText);

    const users = [];
    const traktUsers = [];
    const lists = [];
    const errors = [];

    const normalizeUser = (v) => {
      if (/imdb\.com\/user\/ur\d+\/lists/i.test(v)) return { kind: "imdb", value: v };
      const m = v.match(/ur\d{6,}/i);
      if (m) return { kind: "imdb", value: `https://www.imdb.com/user/${m[0]}/lists/` };
      const trakt = v.match(/trakt\.tv\/users\/([^/]+)/i);
      if (trakt) return { kind: "trakt", value: `https://trakt.tv/users/${trakt[1]}/lists` };
      if (/^[a-z0-9._-]+$/i.test(v)) return { kind: "trakt", value: `https://trakt.tv/users/${v}/lists` };
      return null;
    };

    for (const line of userLines) {
      const norm = normalizeUser(line);
      if (!norm) { errors.push(`Invalid user line: ${line}`); continue; }
      if (norm.kind === "trakt") traktUsers.push(norm.value);
      else users.push(norm.value);
    }

    for (const line of listLines) {
      const tinfo = parseTraktListUrl(line);
      if (tinfo) { lists.push(line); continue; }
      const norm = normalizeListIdOrUrl(line);
      if (norm) { lists.push(norm.url || line); continue; }
      if (isImdbListId(line) || isImdbCustomId(line) || isTraktListId(line)) { lists.push(line); continue; }
      errors.push(`Invalid list line: ${line}`);
    }

    PREFS.sources = PREFS.sources || { users: [], lists: [], traktUsers: [] };
    PREFS.sources.users = Array.from(new Set([ ...(PREFS.sources.users || []), ...users ]));
    PREFS.sources.lists = Array.from(new Set([ ...(PREFS.sources.lists || []), ...lists ]));
    PREFS.sources.traktUsers = Array.from(new Set([ ...(PREFS.sources.traktUsers || []), ...traktUsers ]));

    fullSync({ rediscover: true, force: true })
      .then(() => scheduleNextSync())
      .catch((err) => console.warn("[BULK] background sync failed:", err?.message || err));

    res.json({
      ok: true,
      added: { users: users.length, lists: lists.length, traktUsers: traktUsers.length },
      errors,
      syncQueued: true
    });
  } catch (e) { res.status(500).send(String(e)); }
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

  const ids = listIdsWithEdits(lsid);
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

    if (isOfflineList(lsid)) {
      const list = LISTS[lsid];
      if (!list) return res.status(404).send("List not found");
      list.ids = appendUniqueIds(list.ids || [], [tt]);
      list.orders = list.orders || {};
      list.orders.imdb = list.ids.slice();
      await saveOfflineList(lsid);
    } else {
      PREFS.listEdits = PREFS.listEdits || {};
      const ed = PREFS.listEdits[lsid] || (PREFS.listEdits[lsid] = { added: [], removed: [] });
      if (!ed.added.includes(tt)) ed.added.push(tt);
      ed.removed = (ed.removed || []).filter(x => x !== tt);
      syncFrozenEdits(lsid);
    }

    await getBestMeta(tt);
    CARD.set(tt, cardFor(tt));

    if (isBackedCustomList(lsid)) await saveCustomListBackup(lsid);
    await persistSnapshot();

    res.status(200).send("Added");
  } catch (e) { console.error(e); res.status(500).send("Failed"); }
});

// add many items (tt...) to a list
app.post("/api/list-add-bulk", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lsid = String(req.body.lsid || "");
    const rawIds = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!isListId(lsid)) return res.status(400).send("Bad input");
    if (!rawIds.length) return res.status(400).send("Missing ids");

    const seen = new Set();
    const ids = [];
    for (const raw of rawIds) {
      const tt = extractImdbId(raw);
      if (!tt || !isImdb(tt) || seen.has(tt)) continue;
      seen.add(tt);
      ids.push(tt);
    }
    if (!ids.length) return res.status(400).send("Bad input");

    const existing = new Set(listIdsWithEdits(lsid));
    const toAdd = ids.filter(id => !existing.has(id));

    if (isOfflineList(lsid)) {
      const list = LISTS[lsid];
      if (!list) return res.status(404).send("List not found");
      list.ids = appendUniqueIds(list.ids || [], toAdd);
      list.orders = list.orders || {};
      list.orders.imdb = list.ids.slice();
      await saveOfflineList(lsid);
    } else {
      PREFS.listEdits = PREFS.listEdits || {};
      const ed = PREFS.listEdits[lsid] || (PREFS.listEdits[lsid] = { added: [], removed: [] });
      toAdd.forEach(tt => {
        if (!ed.added.includes(tt)) ed.added.push(tt);
      });
      ed.removed = (ed.removed || []).filter(x => !toAdd.includes(x));
      syncFrozenEdits(lsid);
    }

    if (isBackedCustomList(lsid)) await saveCustomListBackup(lsid);
    await persistSnapshot();

    res.json({ ok: true, added: toAdd.length, requested: ids.length });

    if (toAdd.length) {
      setTimeout(async () => {
        for (const tt of toAdd) {
          try {
            await getBestMeta(tt);
            CARD.set(tt, cardFor(tt));
          } catch (e) { /* ignore */ }
        }
        await persistSnapshot();
      }, 0);
    }
  } catch (e) { console.error(e); res.status(500).send("Failed"); }
});

app.get("/api/list-search-title", async (req, res) => {
  if (!adminAllowed(req)) return res.status(403).json({ ok: false, message: "Forbidden" });
  try {
    const lsid = String(req.query.lsid || "").trim();
    const q = String(req.query.q || "").trim();
    const limitRaw = Number(req.query.limit);
    const limit = Math.min(20, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 5));
    if (lsid && !isListId(lsid)) return res.status(400).json({ ok: false, message: "Bad list" });
    if (!q) return res.status(400).json({ ok: false, message: "Missing query" });
    if (!tmdbEnabled()) return res.status(400).json({ ok: false, message: "TMDB key missing or invalid" });

    const typeRaw = String(req.query.type || "all").toLowerCase();
    const type = (typeRaw === "movie" || typeRaw === "tv") ? typeRaw : "all";
    const results = await searchTmdbTitles(q, { limit, mediaType: type });
    const existing = lsid ? new Set(listIdsWithEdits(lsid)) : new Set();
    const items = results.map(item => ({
      ...item,
      canAdd: !!(item.imdbId && isImdb(item.imdbId) && !existing.has(item.imdbId)),
      inList: !!(item.imdbId && existing.has(item.imdbId))
    }));
    res.json({ ok: true, items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: "Search failed" });
  }
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

    if (isOfflineList(lsid)) {
      const list = LISTS[lsid];
      if (!list) return res.status(404).send("List not found");
      list.ids = (list.ids || []).filter(id => id !== tt);
      list.orders = list.orders || {};
      list.orders.imdb = list.ids.slice();
      await saveOfflineList(lsid);
    } else {
      PREFS.listEdits = PREFS.listEdits || {};
      const ed = PREFS.listEdits[lsid] || (PREFS.listEdits[lsid] = { added: [], removed: [] });

      if (!ed.removed.includes(tt)) ed.removed.push(tt);
      ed.added = (ed.added || []).filter(x => x !== tt);
      syncFrozenEdits(lsid);
    }

    if (isBackedCustomList(lsid)) await saveCustomListBackup(lsid);
    await persistSnapshot();

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
    if (!isOfflineList(lsid)) {
      syncFrozenEdits(lsid);
    }

    await persistSnapshot();

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

    await persistSnapshot();

    res.status(200).json({ ok:true, manifestRev: MANIFEST_REV });
  }catch(e){ console.error("custom-order:", e); res.status(500).send("Failed"); }
});

// add sources quickly then sync
app.post("/api/add-sources", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const users = Array.isArray(req.body.users) ? req.body.users.map(s=>String(s).trim()).filter(Boolean) : [];
    const lists = Array.isArray(req.body.lists) ? req.body.lists.map(s=>String(s).trim()).filter(Boolean) : [];
    const traktUsers = Array.isArray(req.body.traktUsers) ? req.body.traktUsers.map(s=>String(s).trim()).filter(Boolean) : [];
    PREFS.sources = PREFS.sources || { users:[], lists:[], traktUsers: [] };
    PREFS.sources.users = Array.from(new Set([ ...(PREFS.sources.users||[]), ...users ]));
    PREFS.sources.lists = Array.from(new Set([ ...(PREFS.sources.lists||[]), ...lists ]));
    PREFS.sources.traktUsers = Array.from(new Set([ ...(PREFS.sources.traktUsers||[]), ...traktUsers ]));
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send("Sources added & synced");
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});

// backup or remove a list link for recovery
app.post("/api/link-backup", async (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try {
    const lsid = String(req.body.lsid || "");
    const enabled = req.body.enabled !== false;
    const rawValue = String(req.body.value || "").trim();
    let value = rawValue;
    if (!value) {
      if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
      if (isCustomListId(lsid)) return res.status(400).send("Custom lists have no backup link");
      const list = LISTS[lsid];
      value = list?.url || lsid;
    }
    PREFS.linkBackups = Array.isArray(PREFS.linkBackups) ? PREFS.linkBackups : [];
    PREFS.backupConfigs = PREFS.backupConfigs || {};
    if (enabled) {
      PREFS.linkBackups = Array.from(new Set([ ...PREFS.linkBackups, value ]));
      const sortKey = PREFS.perListSort?.[lsid] || "name_asc";
      const sortReverse = !!(PREFS.sortReverse && PREFS.sortReverse[lsid]);
      const customOrder = Array.isArray(PREFS.customOrder?.[lsid]) ? PREFS.customOrder[lsid].slice() : [];
      const name = listDisplayName(lsid);
      const config = { id: lsid, name, url: value, sortKey, sortReverse, customOrder, main: Array.isArray(PREFS.mainLists) && PREFS.mainLists.includes(lsid), savedAt: Date.now() };
      PREFS.backupConfigs[lsid] = config;
      await saveLinkBackupConfig(lsid, config);
    } else {
      PREFS.linkBackups = PREFS.linkBackups.filter(v => v !== value && v !== lsid);
      if (PREFS.backupConfigs) delete PREFS.backupConfigs[lsid];
      await deleteLinkBackupConfig(lsid);
    }
    await persistSnapshot();
    res.json({ ok: true, enabled });
  } catch (e) {
    console.error(e);
    res.status(500).send("Failed to update backup link");
  }
});

// block a list before it syncs
app.post("/api/block-list", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid||"");
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    const list = LISTS[lsid];
    delete LISTS[lsid];
    const removeValues = new Set([lsid]);
    if (list?.url) removeValues.add(list.url);
    PREFS.enabled = (PREFS.enabled||[]).filter(id => id!==lsid);
    PREFS.order   = (PREFS.order||[]).filter(id => id!==lsid);
    PREFS.blocked = Array.from(new Set([ ...(PREFS.blocked||[]), lsid ]));
    if (PREFS.frozenLists) delete PREFS.frozenLists[lsid];
    if (PREFS.displayNames) delete PREFS.displayNames[lsid];
    if (Array.isArray(PREFS.mainLists)) {
      PREFS.mainLists = PREFS.mainLists.filter(id => id !== lsid);
    }
    if (PREFS.backupConfigs) delete PREFS.backupConfigs[lsid];
    await deleteLinkBackupConfig(lsid);
    if (PREFS.linkBackups) {
      PREFS.linkBackups = PREFS.linkBackups.filter(v => !removeValues.has(v));
    }
    LAST_MANIFEST_KEY = ""; MANIFEST_REV++;
    await persistSnapshot();
    res.status(200).send("Blocked");
  }catch(e){ console.error(e); res.status(500).send("Failed to block"); }
});

// remove/block a list
app.post("/api/remove-list", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid||"");
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    if (isCustomListId(lsid)) return res.status(400).send("Use delete for custom lists");
    const list = LISTS[lsid];
    delete LISTS[lsid];
    const removeValues = new Set([lsid]);
    if (list?.url) removeValues.add(list.url);
    PREFS.enabled = (PREFS.enabled||[]).filter(id => id!==lsid);
    PREFS.order   = (PREFS.order||[]).filter(id => id!==lsid);
    PREFS.blocked = Array.from(new Set([ ...(PREFS.blocked||[]), lsid ]));
    if (PREFS.frozenLists) delete PREFS.frozenLists[lsid];
    if (PREFS.displayNames) delete PREFS.displayNames[lsid];
    if (Array.isArray(PREFS.mainLists)) {
      PREFS.mainLists = PREFS.mainLists.filter(id => id !== lsid);
    }
    if (PREFS.backupConfigs) delete PREFS.backupConfigs[lsid];
    await deleteLinkBackupConfig(lsid);
    if (PREFS.linkBackups) {
      PREFS.linkBackups = PREFS.linkBackups.filter(v => !removeValues.has(v));
    }

    LAST_MANIFEST_KEY = ""; MANIFEST_REV++; // force bump
    await persistSnapshot();
    res.status(200).send("Removed & blocked");
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});

app.post("/api/sync", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    await fullSync({ rediscover:true, force: true });
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
    await fullSync({ rediscover:true, force: true });
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

// ------- Admin page (simplified UI: no poster shape) -------
app.get("/admin", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  const base = absoluteBase(req);
  const manifestUrl = `${base}/manifest.json${SHARED_SECRET?`?key=${SHARED_SECRET}`:""}`;

  const lastSyncText = LAST_SYNC_AT
    ? (new Date(LAST_SYNC_AT).toLocaleString() + " (" + Math.round((Date.now()-LAST_SYNC_AT)/60000) + " min ago)")
    : "never";

  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#2f2165" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="My Lists" />
<link rel="manifest" href="/webapp.webmanifest" />
<link rel="apple-touch-icon" href="/pwa-icon.svg" />
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
  .wrap{max-width:1100px;margin:24px auto;padding:0 16px}
  .hero{padding:20px 0 12px}
  h1{margin:0 0 4px;font-weight:700;font-size:26px;letter-spacing:.01em}
  .subtitle{color:var(--muted);font-size:14px}
  .grid{display:grid;gap:16px;grid-template-columns:1fr}
  @media(min-width:980px){ .grid{grid-template-columns:1.1fr .9fr} }
  .card{
    border:1px solid var(--border);
    border-radius:18px;
    padding:16px 18px;
    background:linear-gradient(145deg,rgba(17,14,39,.96),rgba(8,6,25,.98));
    box-shadow:0 18px 40px rgba(0,0,0,.55);
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
  table{width:100%;border-collapse:separate;border-spacing:0 10px;font-size:13px;margin-top:12px}
  th,td{padding:12px 10px;text-align:left;vertical-align:top}
  th{font-weight:600;color:#d7d1ff;font-size:12px;padding-bottom:6px}
  tbody tr:hover td{background:rgba(17,14,40,.7);}
  .muted{color:var(--muted)}
  .chev-cell{width:44px}
  .chev{
    cursor:pointer;
    font-size:20px;
    line-height:1;
    user-select:none;
    display:inline-flex;
    align-items:center;
    justify-content:center;
    width:30px;
    height:30px;
    border-radius:8px;
    background:rgba(28,24,55,.6);
  }
  input[type="checkbox"]{width:18px;height:18px}
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
  .thumb.add.bulk{
    grid-column:1 / -1;
  }
  .thumb.add.bulk .addbox{
    max-width:420px;
    margin:0 auto;
  }
  .tile-move{margin-left:auto;display:flex;flex-direction:column;gap:4px;align-items:flex-end;}
  .tile-move button{padding:4px 6px;font-size:12px;line-height:1;}
  .thumb.tv-move-active{
    outline:2px dashed rgba(139,124,247,.95);
    outline-offset:-2px;
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
  .addbox textarea{
    margin-top:6px;
    width:100%;
    box-sizing:border-box;
    background:#1c1837;
    color:var(--text);
    border:1px solid var(--border);
    border-radius:8px;
    padding:8px;
    min-height:90px;
    resize:vertical;
  }
  .addbox .bulk-btn{
    margin-top:8px;
  }
  .addbox .bulk-status{
    display:block;
    margin-top:6px;
  }
  .rowtools{
    display:flex;
    flex-wrap:wrap;
    gap:8px;
    align-items:center;
    margin-bottom:8px;
    margin-top:4px;
  }
  .rowtools-spacer{flex:1}
  .move-style-toggle{display:flex;align-items:center;gap:8px;}
  .move-style-toggle .seg{display:inline-flex;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:#181433;}
  .move-style-toggle button{padding:6px 10px;border:0;background:transparent;color:var(--muted);box-shadow:none;border-radius:0;}
  .move-style-toggle button.active{background:var(--accent2);color:#fff;}
  .create-panel{
    display:none;
    margin-top:12px;
    padding:12px;
    border:1px solid var(--border);
    border-radius:12px;
    background:#15122c;
  }
  .create-panel.active{display:block;}
  .create-layout{
    display:grid;
    gap:14px;
    grid-template-columns:1.2fr .8fr;
    grid-template-areas:
      "name actions"
      "csv imdb"
      "meta meta";
    align-items:start;
  }
  .create-name{grid-area:name;}
  .create-actions{grid-area:actions;justify-self:end;text-align:right;}
  .create-actions .actions-stack{
    align-items:flex-end;
  }
  .create-csv{grid-area:csv;}
  .create-imdb{grid-area:imdb;}
  .create-meta{grid-area:meta;}
  .actions-stack{
    display:flex;
    flex-direction:column;
    gap:8px;
    align-items:flex-start;
  }
  .create-actions button{
    min-width:110px;
    justify-content:center;
  }
  .name-input{
    max-width:260px;
  }
  .csv-drop{
    position:relative;
    border:1px dashed rgba(170, 144, 255, 0.65);
    background:rgba(127, 120, 255, 0.15);
    padding:22px;
    border-radius:18px;
    text-align:center;
    color:#dcd8ff;
    cursor:pointer;
    transition:background .2s ease, border-color .2s ease;
    min-height:190px;
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:center;
    gap:6px;
  }
  .csv-drop.dragover{
    border-color:#c5b6ff;
    background:rgba(127, 120, 255, 0.25);
  }
  .csv-drop .csv-card{
    background:rgba(12,10,26,.55);
    border:1px solid rgba(90,80,180,.6);
    border-radius:12px;
    padding:8px 12px;
    box-shadow:0 8px 18px rgba(0,0,0,.25);
  }
  .csv-drop input{
    position:absolute;
    inset:0;
    opacity:0;
    width:100%;
    height:100%;
    cursor:pointer;
  }

  .csv-actions{
    display:flex;
    gap:8px;
    margin-top:8px;
    align-items:center;
  }
  .csv-inline-box{
    border:1px dashed var(--border);
    border-radius:12px;
    padding:10px;
    background:rgba(12,10,26,.35);
    min-width:320px;
  }
  .csv-inline-box .mini{display:block;margin-bottom:6px;}
  .csv-inline-box input[type="file"]{width:100%;}
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
  .imdb-box{
    border:1px solid var(--border);
    border-radius:12px;
    padding:12px;
    background:rgba(12,10,26,.45);
  }
  .imdb-box input{
    width:100%;
    box-sizing:border-box;
  }
  .imdb-box textarea{
    width:100%;
    box-sizing:border-box;
    min-height:110px;
    resize:vertical;
    margin-top:6px;
  }
  .imdb-box .bulk-label{
    display:block;
    margin-top:10px;
  }
  .imdb-box .bulk-btn{
    margin-top:8px;
  }
  .title-search-box{
    margin-top:10px;
    border:1px dashed var(--border);
    border-radius:12px;
    padding:10px;
    background:rgba(12,10,26,.35);
  }
  .drawer-search-center{
    max-width:680px;
    margin:10px auto 6px;
  }
  .title-search-row{
    display:flex;
    gap:8px;
    align-items:center;
    flex-wrap:wrap;
  }
  .title-search-row input{
    flex:1;
    min-width:180px;
  }
  .title-search-row select{
    min-width:130px;
  }
  .title-search-clear{
    min-width:34px;
    padding:8px 11px;
    justify-content:center;
  }
  .title-search-status{
    display:block;
    margin-top:7px;
  }
  .title-search-results{
    margin-top:8px;
    display:grid;
    gap:6px;
    max-height:340px;
    overflow-y:auto;
    padding-right:4px;
  }
  .title-search-item{
    display:flex;
    align-items:center;
    gap:8px;
    border:1px solid var(--border);
    border-radius:10px;
    padding:6px 8px;
    background:rgba(16,13,36,.6);
  }
  .title-search-item img{
    width:36px;
    height:54px;
    object-fit:cover;
    border-radius:6px;
    border:1px solid var(--border);
    background:#0f0c21;
  }
  .title-search-item .meta{
    flex:1;
    min-width:0;
    line-height:1.2;
  }
  .title-search-item .meta .name{
    font-size:13px;
    font-weight:600;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
  }
  .title-search-item .meta .sub{
    font-size:11px;
    color:var(--muted);
  }
  .sort-wrap{display:flex;align-items:center;gap:6px;}
  .sort-reverse-btn{
    padding:6px 9px;
    font-size:12px;
    min-width:40px;
    background:var(--card);
    border:1px solid var(--border);
    box-shadow:none;
  }
  .sort-reverse-btn.active{background:var(--accent2);color:#fff;box-shadow:0 6px 16px rgba(139,124,247,.45);}
  .move-btns{display:flex;flex-direction:column;gap:6px;align-items:center;}
  .move-btns button{padding:6px 10px;font-size:13px;line-height:1;}
  .drag-handle{
    display:inline-flex;
    align-items:center;
    justify-content:center;
    width:30px;
    height:30px;
    border-radius:8px;
    background:rgba(28,24,55,.6);
    color:#d7d1ff;
    font-size:19px;
    cursor:grab;
    user-select:none;
  }
  .move-handle-btn{outline:none;}
  .move-handle-btn:focus-visible{
    box-shadow:0 0 0 2px rgba(139,124,247,.85), 0 0 0 5px rgba(108,92,231,.25);
  }
  tr.list-row.tv-move-active{
    outline:2px dashed rgba(139,124,247,.95);
    outline-offset:-2px;
  }
  .mode-toggle{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
  .mode-btn{padding:6px 12px;font-size:12px;}
  .mode-btn.active{background:var(--accent);box-shadow:0 8px 20px rgba(108,92,231,.45);}
  .mode-btn.hidden{display:none;}
  .row-menu{position:relative;}
  .row-menu > summary{
    list-style:none;
    cursor:pointer;
    width:34px;
    height:34px;
    border-radius:10px;
    border:1px solid var(--border);
    display:flex;
    align-items:center;
    justify-content:center;
    background:#181433;
    color:#fff;
    font-size:22px;
    line-height:1;
  }
  .row-menu > summary::-webkit-details-marker{display:none;}
  .row-menu-list{
    position:absolute;
    right:0;
    top:38px;
    min-width:170px;
    padding:6px;
    border-radius:12px;
    border:1px solid #6f67d8;
    background:rgba(18,13,43,.97);
    display:grid;
    gap:4px;
    z-index:12;
    box-shadow:0 20px 34px rgba(0,0,0,.45);
  }
  .row-menu-list button{justify-content:flex-start;border-radius:8px;padding:8px 10px;box-shadow:none;}
  .row-menu-list button.warn{background:#622a2a;}
  .danger-btn{background:#622a2a;box-shadow:0 6px 16px rgba(98,42,42,.45);}
  .mode-simple .normal-only{display:none !important;}
  .mode-simple th, .mode-simple td{padding-top:8px;padding-bottom:8px;}
  .mode-simple .list-row td{vertical-align:middle;}
  .mode-simple .list-row small{display:none;}
  .mode-simple .col-drawer,
  .mode-simple .col-streamlist,
  .mode-simple .col-sort,
  .mode-simple .col-backup{display:none;}
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
  .snapshot-top{
    display:grid;
    gap:16px;
    grid-template-columns:1fr;
  }
  @media(min-width:900px){ .snapshot-top{grid-template-columns:1.1fr .9fr;} }
  .snapshot-actions{
    background:rgba(12,10,26,.65);
    border:1px solid var(--border);
    border-radius:14px;
    padding:12px 14px;
  }
  .tmdb-box{margin-top:12px;}
  .tmdb-row{
    display:flex;
    flex-wrap:wrap;
    gap:8px;
    align-items:center;
  }
  .tmdb-row input{flex:1; min-width:180px;}
  .bulk-box{
    margin-top:14px;
    padding:12px;
    border-radius:14px;
    border:1px solid var(--border);
    background:rgba(16,13,36,.7);
  }
  .bulk-grid{
    display:grid;
    gap:12px;
    grid-template-columns:1fr;
  }
  @media(min-width:900px){ .bulk-grid{grid-template-columns:1fr 1fr;} }
  textarea{
    width:100%;
    box-sizing:border-box;
    background:#1c1837;
    color:var(--text);
    border:1px solid var(--border);
    border-radius:8px;
    padding:8px 9px;
    font-size:13px;
  }
  .merge-box{
    margin:12px 0;
    padding:12px;
    border-radius:14px;
    border:1px dashed var(--border);
    background:rgba(12,10,26,.55);
  }
  .merge-grid{
    display:grid;
    gap:8px;
    grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
  }
  .merge-dropdown{
    margin-top:8px;
    border:1px solid var(--border);
    border-radius:12px;
    background:rgba(18,15,37,.7);
    overflow:hidden;
  }
  .merge-dropdown > summary{
    list-style:none;
    cursor:pointer;
    padding:10px 12px;
    font-weight:600;
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:10px;
  }
  .merge-dropdown > summary::-webkit-details-marker{display:none;}
  .merge-dropdown > summary::after{content:'▾';opacity:.8;transition:transform .2s ease;}
  .merge-dropdown[open] > summary::after{transform:rotate(180deg);}
  .merge-dropdown-body{padding:0 12px 12px;display:grid;gap:10px;}
  .advanced-drawer{position:relative;top:-10px;}
  .advanced-drawer td{
    background:rgba(17,14,40,.7);
    padding:0 10px 10px;
    border-left:1px solid rgba(38,33,69,.85);
    border-right:1px solid rgba(38,33,69,.85);
    border-bottom:1px solid rgba(38,33,69,.85);
    border-top:0;
    border-radius:0 0 14px 14px;
  }
  tr.list-row.advanced-open td:first-child{border-radius:14px 0 0 0;}
  tr.list-row.advanced-open td:last-child{border-radius:0 14px 0 0;}
  .advanced-panel{
    padding:12px;
    border-radius:14px;
    border:1px solid var(--border);
    background:#151130;
    display:grid;
    gap:10px;
    grid-template-columns:minmax(260px,1.3fr) minmax(280px,1fr);
    align-items:start;
  }
  @media(max-width:980px){
    .advanced-panel{grid-template-columns:1fr;}
  }
  .advanced-row{
    display:flex;
    flex-wrap:wrap;
    gap:8px;
    align-items:center;
  }
  .advanced-row.stack{display:grid;gap:8px;align-items:start;}
  .advanced-row.stack .imdb-box{margin:0;}
  .adv-inline-btn{margin-top:8px;margin-left:10px;padding:6px 10px;font-size:12px;}
  .hide-list-btn{display:block;margin-top:8px;padding:5px 10px;font-size:12px;}
  tr.list-row.main + tr.advanced-drawer td{
    border-left-color:rgba(243,195,65,.35);
    border-right-color:rgba(243,195,65,.35);
    border-bottom-color:rgba(243,195,65,.35);
    background:rgba(243,195,65,.08);
  }
  tr.list-row td{
    background:rgba(17,14,40,.7);
    border-top:1px solid rgba(38,33,69,.85);
    border-bottom:1px solid rgba(38,33,69,.85);
  }
  tr.list-row td:first-child{
    border-left:1px solid rgba(38,33,69,.85);
    border-radius:14px 0 0 14px;
  }
  tr.list-row td:last-child{
    border-right:1px solid rgba(38,33,69,.85);
    border-radius:0 14px 14px 0;
  }
  tr.list-row.main td{
    background:rgba(243,195,65,.14);
    border-top-color:rgba(243,195,65,.35);
    border-bottom-color:rgba(243,195,65,.35);
  }
  tr.list-row.main td:first-child{border-left-color:rgba(243,195,65,.35);}
  tr.list-row.main td:last-child{border-right-color:rgba(243,195,65,.35);}
  .status-pill{
    display:inline-flex;
    align-items:center;
    gap:6px;
    padding:4px 8px;
    border-radius:999px;
    font-size:12px;
    background:#1c1837;
    border:1px solid var(--border);
  }
  .status-pill.ok{color:#7dffb1;border-color:#2b7a53;background:rgba(43,122,83,.25);}
  .status-pill.bad{color:#ffb4b4;border-color:#6b2f2f;background:rgba(107,47,47,.35);}
  .nav{
    display:flex;
    gap:10px;
    flex-wrap:wrap;
    margin-bottom:16px;
    justify-content:center;
  }
  .nav-btn{
    background:var(--card);
    border:1px solid var(--border);
    color:var(--text);
    padding:10px 16px;
    border-radius:999px;
    cursor:pointer;
    box-shadow:0 6px 16px rgba(0,0,0,.35);
  }
  .nav-btn.active{
    background:var(--accent);
    box-shadow:0 10px 26px rgba(108,92,231,.55);
  }
  .section{width:100%;display:none;}
  .section.active{display:block;}
  .center-card{max-width:980px;margin:0 auto;}
  .wrap{display:flex;flex-direction:column;align-items:center;}
  .collapse-toggle{
    display:inline-flex;
    align-items:center;
    gap:6px;
    margin-top:6px;
    background:var(--card);
    border:1px solid var(--border);
    color:var(--text);
    padding:6px 10px;
    border-radius:999px;
    cursor:pointer;
    font-size:12px;
  }
  .collapse-toggle svg{width:14px;height:14px;fill:currentColor;transition:transform .2s ease;}
  .collapse-toggle[aria-expanded="true"] svg{transform:rotate(180deg);}
  .collapse-body{margin-top:8px;display:none;}
  .collapse-body.open{display:block;}
  .link-tools{margin-top:8px;}
  .link-pills{margin-top:6px;}
  .icon-btn{
    display:inline-flex;
    align-items:center;
    justify-content:center;
    gap:6px;
    padding:8px 12px;
    border-radius:10px;
    border:1px solid var(--border);
    background:var(--card);
    color:var(--text);
    cursor:pointer;
  }
  .icon-btn svg{width:20px;height:20px;fill:currentColor;}
  .drawer td{
    padding:14px 16px;
    border-radius:16px;
    border:1px solid rgba(38,33,69,.85);
    background:#120f25;
  }
  .icon-btn.cloud.active{background:rgba(108,92,231,.2);border-color:#7f78ff;color:#b3b0ff;}
  .icon-btn.danger{color:#ff9b9b;border-color:#6b2f2f;background:rgba(107,47,47,.2);}
  .icon-btn.home{color:#ffe68a;border-color:#6a5a1a;background:rgba(106,90,26,.25);}
  .icon-btn.home.active{color:#ffd24a;border-color:#f3c341;background:rgba(243,195,65,.25);box-shadow:0 8px 18px rgba(243,195,65,.25);}
  .icon-btn.home.inactive{opacity:.5;}
  .discovered-item{
    display:flex;
    align-items:flex-start;
    justify-content:space-between;
    gap:10px;
  }
</style>
</head><body>
<div class="wrap">
  <div class="hero">
    <h1>My Lists – Admin</h1>
    <div class="subtitle">Last sync: ${lastSyncText}</div>
  </div>

  <div class="nav">
    <button class="nav-btn active" data-target="snapshot">Snapshot</button>
    <button class="nav-btn" data-target="add">Add Lists</button>
    <button class="nav-btn" data-target="customize">Customize Layout</button>
  </div>

  <section id="section-snapshot" class="section active">
    <div class="card center-card">
      <div class="snapshot-top">
        <div>
          <h3>Manifest URL</h3>
          <p class="code" id="manifestUrl">${manifestUrl}</p>
          <div class="installRow">
            <button type="button" class="btn2" id="installBtn">⭐ Install to Stremio</button>
            <span class="mini muted">If the button doesn’t work, copy the manifest URL into Stremio manually.</span>
          </div>
          <p class="mini muted" style="margin-top:8px;">Manifest version automatically bumps when catalogs, sorting, or ordering change.</p>
        </div>
        <div class="snapshot-actions">
          <h4>Sync Controls</h4>
          <div class="rowtools">
            <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}">
              <button class="btn2" type="submit">🔁 Sync Lists Now</button>
            </form>
            <form method="POST" action="/api/purge-sync?admin=${ADMIN_PASSWORD}" onsubmit="return confirm('Purge & re-sync everything?')">
              <button type="submit">🧹 Purge & Sync</button>
            </form>
          </div>
          <span class="inline-note">Auto-sync every <b>${IMDB_SYNC_MINUTES}</b> min.</span>
          <div class="tmdb-box">
            <label class="mini">TMDB API Key (optional)</label>
            <div class="tmdb-row">
              <input id="tmdbKeyInput" type="text" placeholder="Enter TMDB API key" />
              <button id="tmdbSaveBtn" type="button">Save</button>
              <button id="tmdbVerifyBtn" type="button" class="btn2">Verify</button>
            </div>
            <div class="mini muted">Use a TMDB v3 API key or a v4 Read Access Token.</div>
            <div id="tmdbStatus" class="mini muted"></div>
          </div>
        </div>
      </div>
      <h3 style="margin-top:18px;">Current Snapshot</h3>
      <button class="collapse-toggle" type="button" data-target="snapshotBody" aria-expanded="false">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.6 7.4a1 1 0 0 1 1.4 0L10 10.4l3-3a1 1 0 1 1 1.4 1.4l-3.7 3.7a1 1 0 0 1-1.4 0L5.6 8.8a1 1 0 0 1 0-1.4z"/></svg>
        <span>Show</span>
      </button>
      <div id="snapshotBody" class="collapse-body">
        <ul id="snapshotList"></ul>
      </div>
    </div>
  </section>

  <section id="section-add" class="section">
    <div class="card center-card">
      <h3>Add & Sources</h3>
      <p class="mini muted" style="margin-top:6px;">We merge your main user (+ extras) and explicit list URLs/IDs. Removing a list also blocks it so it won’t re-appear on the next sync.</p>

      <div class="row">
        <div><label class="mini">Add IMDb/Trakt <b>User</b> URL</label>
          <input id="userInput" placeholder="IMDb user /lists URL or Trakt user" />
        </div>
        <div><button id="addUser" type="button">Add</button></div>
      </div>
      <div class="row">
        <div><label class="mini">Add IMDb/Trakt <b>List</b> URL</label>
          <input id="listInput" placeholder="IMDb ls…/watchlist or Trakt list/watchlist URL" />
        </div>
        <div><button id="addList" type="button">Add</button></div>
      </div>

      <div class="bulk-box">
        <h4>Bulk Add (paste multiple lines)</h4>
        <div class="bulk-grid">
          <div>
            <label class="mini">Bulk Users (IMDb user list URLs or Trakt usernames/URLs)</label>
            <textarea id="bulkUsers" rows="5" placeholder="https://www.imdb.com/user/ur1234567/lists/&#10;https://trakt.tv/users/someone"></textarea>
          </div>
          <div>
            <label class="mini">Bulk Lists (IMDb/Trakt list URLs, ls IDs, imdb:/trakt: ids)</label>
            <textarea id="bulkLists" rows="5" placeholder="ls1234567&#10;https://www.imdb.com/list/ls1234567/"></textarea>
          </div>
        </div>
        <div class="rowtools">
          <button id="bulkAddBtn" type="button">Bulk Add</button>
          <span id="bulkStatus" class="mini muted"></span>
        </div>
      </div>

      <div class="link-tools">
        <h4>Link Managers</h4>
        <button class="collapse-toggle" type="button" data-target="linkManagers" aria-expanded="false">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.6 7.4a1 1 0 0 1 1.4 0L10 10.4l3-3a1 1 0 1 1 1.4 1.4l-3.7 3.7a1 1 0 0 1-1.4 0L5.6 8.8a1 1 0 0 1 0-1.4z"/></svg>
          <span>Show</span>
        </button>
        <div id="linkManagers" class="collapse-body">
          <div style="margin-top:10px">
            <div class="mini muted">Your IMDb users:</div>
            <div id="userPills"></div>
          </div>
          <div style="margin-top:8px">
            <div class="mini muted">Trakt users to scan:</div>
            <div id="traktUserPills"></div>
          </div>
          <div style="margin-top:8px">
            <div class="mini muted">Your extra lists:</div>
            <div id="listPills"></div>
          </div>
          <div style="margin-top:8px">
            <div class="mini muted">Backups:</div>
            <div id="backupConfigs"></div>
          </div>
          <div style="margin-top:12px">
            <div class="mini muted">Blocked lists (won't re-add on sync):</div>
            <div id="blockedPills"></div>
          </div>
        </div>
      </div>

      
      <h4 style="margin-top:14px">Discovered</h4>
      <button class="collapse-toggle" type="button" data-target="discoveredBody" aria-expanded="false">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.6 7.4a1 1 0 0 1 1.4 0L10 10.4l3-3a1 1 0 1 1 1.4 1.4l-3.7 3.7a1 1 0 0 1-1.4 0L5.6 8.8a1 1 0 0 1 0-1.4z"/></svg>
        <span>Show</span>
      </button>
      <div id="discoveredBody" class="collapse-body">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div id="discoveredStatus" class="mini muted"></div>
        </div>
        <ul id="discoveredList"></ul>
      </div>
    </div>
  </section>

  <section id="section-customize" class="section">
    <div class="card center-card">
      <h3>Customize Layout</h3>
      <p class="muted" id="customizeLeadText">Simple mode is the default for a clean compact layout. Switch to Normal mode for full controls and list item tools.</p>
      <div class="mode-toggle" id="layoutModeToggle">
        <button id="simpleModeBtn" class="mode-btn" type="button">Simple mode</button>
        <button id="normalModeBtn" class="mode-btn btn2" type="button">Normal mode</button>
        <span class="mini muted">Simple mode hides item drawers and advanced controls.</span>
      </div>
      <div class="rowtools">
        <label class="pill normal-only"><input type="checkbox" id="advancedToggle" /> <span>Advanced</span></label>
        <button id="showHiddenBtn" type="button" class="btn2" style="display:none;">Show hidden lists</button>
        <span class="mini muted normal-only">Advanced mode expands list cards inline for rename, freeze, duplicate, and merge tools.</span>
        <span class="rowtools-spacer"></span>
        <div id="moveStyleToggle" class="move-style-toggle normal-only" aria-label="Normal mode move controls">
          <span class="mini muted">Move controls</span>
          <div class="seg" role="group" aria-label="Move control style">
            <button type="button" id="moveStyleHandleBtn">☰</button>
            <button type="button" id="moveStyleArrowsBtn">↑↓</button>
          </div>
        </div>
        <button id="createOfflineBtn" type="button">＋ Create list</button>
      </div>
      <div id="createOfflinePanel" class="create-panel">
        <div class="create-layout">
          <div class="create-name">
            <label class="mini">List name</label>
            <input id="offlineListName" class="name-input" type="text" placeholder="Name your list" />
          </div>
          <div class="create-actions">
            <div class="actions-stack">
              <button id="offlineSaveBtn" type="button">Save list</button>
              <button id="offlineCancelBtn" type="button">Cancel</button>
              <span id="offlineSaveStatus" class="mini muted"></span>
            </div>
          </div>
          <div class="create-csv">
            <label class="mini">Add CSV from IMDb</label>
            <label class="csv-drop" id="offlineCsvDrop">
              <input id="offlineCsvInput" type="file" accept=".csv,text/csv" />
              <div class="csv-card">
                <div><b>Drop your IMDb CSV</b> or click to choose file</div>
                <div class="mini muted">Drag & drop is supported. We read IMDb tt... IDs in order.</div>
              </div>
              <div id="offlineCsvStatus" class="mini muted"></div>
            </label>
            <div class="csv-actions">
              <button id="offlineCsvImportBtn" type="button" disabled>Import CSV</button>
              <button id="offlineCsvCancelBtn" type="button" class="btn2" disabled>Cancel CSV</button>
            </div>
          </div>
          <div class="create-imdb">
            <div class="imdb-box">
              <label class="mini">Add by IMDb ID (tt...)</label>
              <input id="offlineAddIdInput" type="text" placeholder="tt1234567 or IMDb URL" />
              <div id="offlineTitleSearchMount"></div>
              <label class="mini bulk-label">Add those IMDb tt in bulk</label>
              <textarea id="offlineAddBulkInput" placeholder="tt1234567 tt7654321 or IMDb URLs"></textarea>
              <button id="offlineAddBulkBtn" class="bulk-btn" type="button">Add bulk</button>
            </div>
          </div>
          <div class="create-meta">
            <div class="mini muted">Items queued: <span id="offlineItemCount">0</span></div>
          </div>
        </div>
      </div>
      <div id="mergeBuilder" class="merge-box" style="display:none;"></div>
      <div id="prefs"></div>
    </div>
  </section>

</div>

<script>
const ADMIN="${ADMIN_PASSWORD}";
const SORT_OPTIONS = ${JSON.stringify(SORT_OPTIONS)};
const HOST_URL = ${JSON.stringify(base)};
const SECRET = ${JSON.stringify(SHARED_SECRET)};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

let discoveredCache = null;
let discoveredLoading = false;
let customizeDraft = null;

async function getPrefs(){ const r = await fetch('/api/prefs?admin='+ADMIN); return r.json(); }
async function getLists(){ const r = await fetch('/api/lists?admin='+ADMIN); return r.json(); }
async function getListItems(lsid){ const r = await fetch('/api/list-items?admin='+ADMIN+'&lsid='+encodeURIComponent(lsid)); return r.json(); }
async function getDiscovered(){ const r = await fetch('/api/discovered?admin='+ADMIN); return r.json(); }
async function saveCustomOrder(lsid, order){
  const r = await fetch('/api/custom-order?admin='+ADMIN, {method:'POST',headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid, order })});
  if (!r.ok) throw new Error('save failed');
  return r.json();
}

// --- Install Button Logic ---
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

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.section').forEach(sec => {
        sec.classList.toggle('active', sec.id === 'section-' + target);
      });
    });
  });

  const params = new URLSearchParams(window.location.search || '');
  const openView = (params.get('view') || '').toLowerCase();
  const forceMode = (params.get('mode') || '').toLowerCase();
  if (forceMode === 'normal') localStorage.setItem('customizeMode', 'normal');
  if (openView === 'customize') {
    const targetBtn = document.querySelector('.nav-btn[data-target="customize"]');
    if (targetBtn) targetBtn.click();
  }

  document.querySelectorAll('.collapse-toggle').forEach(btn => {
    const target = document.getElementById(btn.dataset.target || '');
    if (!target) return;
    btn.addEventListener('click', () => {
      const open = !target.classList.contains('open');
      target.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      const label = btn.querySelector('span');
      if (label) label.textContent = open ? 'Hide' : 'Show';
      if (open && btn.dataset.target === 'discoveredBody' && typeof window.renderDiscovered === 'function') {
        window.renderDiscovered(true);
      }
    });
  });
});

function normalizeUserListsUrl(v){
  v = String(v||'').trim();
  if (!v) return null;
  if (/imdb\\.com\\/user\\/ur\\d+\\/lists/i.test(v)) return { kind:'imdb', value: v };
  const m = v.match(/ur\\d{6,}/i);
  if (m) return { kind:'imdb', value: 'https://www.imdb.com/user/'+m[0]+'/lists/' };

  const trakt = v.match(/trakt\\.tv\\/users\\/([^/]+)/i);
  if (trakt) return { kind:'trakt', value: 'https://trakt.tv/users/' + trakt[1] + '/lists' };
  return { kind:'trakt', value: 'https://trakt.tv/users/' + v + '/lists' };
}
function normalizeListIdOrUrl2(v){
  v = String(v||'').trim();
  if (!v) return null;
  if (/^imdb:[a-z0-9._-]+$/i.test(v) || /^trakt:[^:]+:[^:]+$/i.test(v) || /^ls\\d{6,}$/i.test(v)) return v;
  // Trakt lists
  if (/trakt\\.tv\\/users\\/[^/]+\\/lists\\/[^/?#]+/i.test(v)) return v;
  if (/trakt\\.tv\\/users\\/[^/]+\\/watchlist/i.test(v)) return v;
  if (/trakt\\.tv\\/lists\\//i.test(v)) return v;
  // IMDb lists
  if (/imdb\\.com\\/user\\/ur\\d+\\/watchlist/i.test(v)) return v;
  if (/imdb\\.com\\/(list\\/ls\\d{6,}|chart\\/|search\\/title)/i.test(v)) return v;
  const m = v.match(/ls\\d{6,}/i);
  if (m) return 'https://www.imdb.com/list/'+m[0]+'/';
  if (/imdb\\.com\\/chart\\//i.test(v) || /imdb\\.com\\/search\\/title/i.test(v)) {
    return v.startsWith('http') ? v : 'https://www.imdb.com'+v;
  }
  return null;

}
async function addSources(payload){
  const r = await fetch('/api/add-sources?admin='+ADMIN, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(await r.text());
}
function wireAddButtons(){
  const userBtn = document.getElementById('addUser');
  const listBtn = document.getElementById('addList');
  const userInp = document.getElementById('userInput');
  const listInp = document.getElementById('listInput');
  const traktUserBtn = document.getElementById('addTraktUser');
  const traktUserInp = document.getElementById('traktUserInput');

  userBtn.onclick = async (e) => {
    e.preventDefault();
    const norm = normalizeUserListsUrl(userInp.value);
    if (!norm) { alert('Enter a valid IMDb user /lists URL, ur… id, or Trakt user'); return; }
    userBtn.disabled = true;
    try {
      const payload = { users:[], lists:[], traktUsers:[] };
      if (norm.kind === 'trakt') payload.traktUsers.push(norm.value);
      else payload.users.push(norm.value);
      await addSources(payload);
      await render();
    }
    catch (e) { alert(e.message || 'Add failed'); }
    finally { userBtn.disabled = false; }
  };

  listBtn.onclick = async (e) => {
    e.preventDefault();
    const url = normalizeListIdOrUrl2(listInp.value);
    if (!url) { alert('Enter a valid IMDb list/watchlist URL, ls… id, or Trakt list/watchlist URL'); return; }
    listBtn.disabled = true;
    try { await addSources({ users:[], lists:[url] }); await render(); }
    catch (e) { alert(e.message || 'Add failed'); }
    finally { listBtn.disabled = false; }
  };


}

function wireOfflineCreatePanel(refresh) {
  const btn = document.getElementById('createOfflineBtn');
  const panel = document.getElementById('createOfflinePanel');
  const nameInput = document.getElementById('offlineListName');
  const addInput = document.getElementById('offlineAddIdInput');
  const searchMount = document.getElementById('offlineTitleSearchMount');
  const addBulkInput = document.getElementById('offlineAddBulkInput');
  const addBulkBtn = document.getElementById('offlineAddBulkBtn');
  const csvInput = document.getElementById('offlineCsvInput');
  const csvDrop = document.getElementById('offlineCsvDrop');
  const csvStatus = document.getElementById('offlineCsvStatus');
  const csvImportBtn = document.getElementById('offlineCsvImportBtn');
  const csvCancelBtn = document.getElementById('offlineCsvCancelBtn');
  const saveBtn = document.getElementById('offlineSaveBtn');
  const cancelBtn = document.getElementById('offlineCancelBtn');
  const saveStatus = document.getElementById('offlineSaveStatus');
  const countEl = document.getElementById('offlineItemCount');
  if (!btn || !panel) return;

  let draftIds = [];
  const draftSearch = (searchMount && typeof createTitleSearchWidget === 'function')
    ? createTitleSearchWidget({
        onAdd: async (imdbId) => {
          if (!draftIds.includes(imdbId)) draftIds.push(imdbId);
          updateCount();
        }
      })
    : null;
  if (draftSearch && searchMount) searchMount.appendChild(draftSearch.el);

  let pendingCsvIds = [];
  const setPendingCsv = (ids) => {
    pendingCsvIds = Array.isArray(ids) ? ids.slice() : [];
    const has = pendingCsvIds.length > 0;
    if (csvImportBtn) csvImportBtn.disabled = !has;
    if (csvCancelBtn) csvCancelBtn.disabled = !has;
  };

  const updateCount = () => {
    if (countEl) countEl.textContent = String(draftIds.length);
  };
  const reset = () => {
    draftIds = [];
    if (nameInput) nameInput.value = '';
    if (addInput) addInput.value = '';
    if (addBulkInput) addBulkInput.value = '';
    if (csvInput) csvInput.value = '';
    if (csvStatus) csvStatus.textContent = '';
    setPendingCsv([]);
    if (saveStatus) saveStatus.textContent = '';
    if (draftSearch) draftSearch.resetSession();
    panel.classList.remove('active');
    updateCount();
  };

  btn.onclick = () => {
    panel.classList.toggle('active');
    if (panel.classList.contains('active') && nameInput) nameInput.focus();
  };

  if (addInput) {
    addInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const m = (addInput.value || '').match(/tt\\d{7,}/i);
      if (!m) { alert('Enter a valid IMDb id'); return; }
      const id = m[0];
      if (!draftIds.includes(id)) draftIds.push(id);
      addInput.value = '';
      updateCount();
    });
  }
  if (addBulkBtn && addBulkInput) {
    const addBulk = () => {
      const ids = parseImdbIdsFromText(addBulkInput.value);
      if (!ids.length) { alert('Enter IMDb ids or IMDb URLs.'); return; }
      ids.forEach(id => { if (!draftIds.includes(id)) draftIds.push(id); });
      addBulkInput.value = '';
      updateCount();
    };
    addBulkBtn.onclick = (e) => { e.preventDefault(); addBulk(); };
    addBulkInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        addBulk();
      }
    });
  }

  const handleCsvFile = async (file) => {
    if (!file) return;
    if (csvStatus) csvStatus.textContent = 'Reading CSV…';
    try {
      const text = await file.text();
      const ids = parseCsvImdbIds(text);
      setPendingCsv(ids);
      if (csvStatus) csvStatus.textContent = ids.length
        ? ('Loaded ' + ids.length + ' IMDb IDs. Click Import CSV to add them.')
        : 'No IMDb IDs found in this CSV.';
    } catch (e) {
      setPendingCsv([]);
      if (csvStatus) csvStatus.textContent = 'Failed to read CSV.';
    } finally {
      if (csvInput) csvInput.value = '';
    }
  };
  if (csvInput) {
    csvInput.onchange = async () => {
      const file = csvInput.files && csvInput.files[0];
      await handleCsvFile(file);
    };
  }
  if (csvDrop) {
    csvDrop.addEventListener('dragover', (e) => {
      e.preventDefault();
      csvDrop.classList.add('dragover');
    });
    csvDrop.addEventListener('dragleave', () => {
      csvDrop.classList.remove('dragover');
    });
    csvDrop.addEventListener('drop', async (e) => {
      e.preventDefault();
      csvDrop.classList.remove('dragover');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      await handleCsvFile(file);
    });
  }

  if (csvImportBtn) {
    csvImportBtn.onclick = (e) => {
      e.preventDefault();
      if (!pendingCsvIds.length) return;
      pendingCsvIds.forEach(id => { if (!draftIds.includes(id)) draftIds.push(id); });
      if (csvStatus) csvStatus.textContent = 'Imported ' + pendingCsvIds.length + ' IMDb IDs from CSV.';
      setPendingCsv([]);
      updateCount();
    };
  }
  if (csvCancelBtn) {
    csvCancelBtn.onclick = (e) => {
      e.preventDefault();
      setPendingCsv([]);
      if (csvInput) csvInput.value = '';
      if (csvStatus) csvStatus.textContent = 'CSV selection cleared.';
    };
  }

  if (saveBtn) {
    saveBtn.onclick = async () => {
      const name = (nameInput?.value || '').trim();
      if (!name) { alert('List name is required.'); return; }
      saveBtn.disabled = true;
      if (saveStatus) saveStatus.textContent = 'Saving…';
      try {
        const r = await fetch('/api/create-offline-list?admin=' + ADMIN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, ids: draftIds })
        });
        if (!r.ok) throw new Error(await r.text());
        if (saveStatus) saveStatus.textContent = 'Saved.';
        reset();
        if (typeof refresh === 'function') await refresh();
      } catch (e) {
        if (saveStatus) saveStatus.textContent = e.message || 'Save failed.';
      } finally {
        saveBtn.disabled = false;
      }
    };
  }

  if (cancelBtn) {
    cancelBtn.onclick = () => reset();
  }
}

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
if (!window.__rowMenuOutsideClickBound) {
  window.__rowMenuOutsideClickBound = true;
  document.addEventListener('click', (evt) => {
    if (evt.target && evt.target.closest && evt.target.closest('details.row-menu')) return;
    document.querySelectorAll('details.row-menu[open]').forEach((d) => { d.open = false; });
  });
}
function isCtrl(node){
  const t = (node && node.tagName || "").toLowerCase();
  return t === "input" || t === "select" || t === "button" || t === "a" || t === "label" || t === "textarea";
}
function parseImdbIdsFromText(text){
  const ids = [];
  const seen = new Set();
  const matches = String(text || '').matchAll(/tt\\d{7,}/gi);
  for (const m of matches) {
    const tt = m[0];
    if (seen.has(tt)) continue;
    seen.add(tt);
    ids.push(tt);
  }
  return ids;
}
function parseCsvImdbIds(text){
  const lines = String(text || '').split(/\\r?\\n/);
  const ids = [];
  const seen = new Set();
  for (const line of lines) {
    const m = line.match(/tt\\d{7,}/i);
    if (!m) continue;
    const tt = m[0];
    if (seen.has(tt)) continue;
    seen.add(tt);
    ids.push(tt);
  }
  return ids;
}

function createTitleSearchWidget({ lsid = '', onAdd = null } = {}) {
  const root = el('div', { class: 'title-search-box' });
  const label = el('label', { class: 'mini', text: 'Search TMDB by title and add item' });
  const row = el('div', { class: 'title-search-row' });
  const input = el('input', { type: 'text', placeholder: 'Type title name (e.g. Inception)', spellcheck: 'false' });
  const typeSel = el('select');
  typeSel.appendChild(el('option', { value: 'all', text: 'All' }));
  typeSel.appendChild(el('option', { value: 'movie', text: 'Movies' }));
  typeSel.appendChild(el('option', { value: 'tv', text: 'Shows' }));
  const searchBtn = el('button', { class: 'bulk-btn', type: 'button', text: 'Search' });
  const clearBtn = el('button', { class: 'btn2 title-search-clear', type: 'button', text: '✕', title: 'Clear search' });
  const status = el('span', { class: 'mini muted title-search-status' });
  const results = el('div', { class: 'title-search-results' });
  row.appendChild(input);
  row.appendChild(typeSel);
  row.appendChild(searchBtn);
  row.appendChild(clearBtn);
  root.appendChild(label);
  root.appendChild(row);
  root.appendChild(status);
  root.appendChild(results);

  const localAdded = new Set();
  let lastItems = [];

  function resetUi({ keepInput = false } = {}) {
    if (!keepInput) input.value = '';
    status.textContent = '';
    results.innerHTML = '';
    lastItems = [];
  }

  function canAddItem(item) {
    if (!item || !item.imdbId) return false;
    if (item.inList) return false;
    if (localAdded.has(item.imdbId)) return false;
    return !!item.canAdd;
  }

  function renderItems(items) {
    results.innerHTML = '';
    items.forEach((item) => {
      const rowEl = el('div', { class: 'title-search-item' });
      const poster = document.createElement('img');
      poster.src = item.poster || 'https://images.metahub.space/poster/small/tt0111161/img';
      poster.alt = item.title || 'Poster';
      const meta = el('div', { class: 'meta' });
      const typeLabel = item.mediaType === 'tv' ? 'Series' : 'Movie';
      const yearText = Number.isFinite(item.year) ? String(item.year) : 'Unknown year';
      const name = el('div', { class: 'name', text: (item.title || 'Untitled') + ' (' + yearText + ')' });
      const subtitle = el('div', { class: 'sub', text: typeLabel + (item.imdbId ? ' • ' + item.imdbId : ' • no IMDb id') });
      meta.appendChild(name);
      meta.appendChild(subtitle);

      const addBtn = el('button', { class: 'btn2', type: 'button', text: item.inList || localAdded.has(item.imdbId) ? 'Added' : 'Add' });
      addBtn.disabled = !canAddItem(item);
      addBtn.onclick = async () => {
        if (!item.imdbId || addBtn.disabled) return;
        addBtn.disabled = true;
        addBtn.textContent = 'Adding…';
        status.textContent = 'Adding ' + item.imdbId + '…';
        try {
          if (typeof onAdd === 'function') await onAdd(item.imdbId, item);
          else if (lsid) {
            const r = await fetch('/api/list-add?admin=' + ADMIN, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ lsid, id: item.imdbId })
            });
            if (!r.ok) throw new Error(await r.text());
          }
          localAdded.add(item.imdbId);
          item.canAdd = false;
          addBtn.textContent = 'Added';
          status.textContent = 'Added ' + item.imdbId + '.';
        } catch (e) {
          addBtn.disabled = false;
          addBtn.textContent = 'Add';
          status.textContent = e.message || 'Add failed.';
        }
      };

      rowEl.appendChild(poster);
      rowEl.appendChild(meta);
      rowEl.appendChild(addBtn);
      results.appendChild(rowEl);
    });
  }

  async function runSearch() {
    const q = (input.value || '').trim();
    if (!q) { alert('Enter a title to search.'); return; }
    searchBtn.disabled = true;
    input.disabled = true;
    clearBtn.disabled = true;
    status.textContent = 'Searching…';
    results.innerHTML = '';
    try {
      const qs = new URLSearchParams({ admin: ADMIN, q, limit: '20', type: typeSel.value || 'all' });
      if (lsid) qs.set('lsid', lsid);
      const r = await fetch('/api/list-search-title?' + qs.toString());
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || 'Title search failed');
      const items = Array.isArray(data.items) ? data.items : [];
      lastItems = items;
      renderItems(items);
      status.textContent = items.length ? ('Found ' + items.length + ' result' + (items.length === 1 ? '' : 's') + '.') : 'No matches found.';
    } catch (e) {
      status.textContent = e.message || 'Title search failed.';
    } finally {
      searchBtn.disabled = false;
      input.disabled = false;
      clearBtn.disabled = false;
    }
  }

  searchBtn.addEventListener('click', (e) => {
    e.preventDefault();
    runSearch();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });
  clearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    resetUi();
    input.focus();
  });

  return {
    el: root,
    clear: () => resetUi(),
    resetSession: () => {
      localAdded.clear();
      resetUi();
    }
  };
}

// Row drag (table tbody)
function attachRowDnD(tbody) {
  let dragSrc = null;
  tbody.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr[data-lsid]');
    if (!tr || isCtrl(e.target)) return;
    dragSrc = tr;
    tr.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tr.dataset.lsid || '');
  });
  tbody.addEventListener('dragend', () => {
    if (dragSrc) dragSrc.classList.remove('dragging');
    dragSrc = null;
  });
  tbody.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragSrc) return;
    const over = e.target.closest('tr[data-lsid]');
    if (!over || over === dragSrc) return;
    const rect = over.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    over.parentNode.insertBefore(dragSrc, before ? over : over.nextSibling);
  });
}

function moveRowByButtons(tr, dir){
  const tbody = tr.parentNode;
  const rows = Array.from(tbody.querySelectorAll('tr[data-lsid]'));
  const idx = rows.indexOf(tr);
  if (idx < 0 || rows.length < 2) return;
  const tentative = idx + dir;
  const nextIdx = tentative < 0 ? rows.length - 1 : (tentative >= rows.length ? 0 : tentative);
  const ref = rows[nextIdx];
  if (dir < 0) {
    if (nextIdx === rows.length - 1) tbody.insertBefore(tr, ref.nextSibling);
    else tbody.insertBefore(tr, ref);
  } else {
    if (nextIdx === 0) tbody.insertBefore(tr, ref);
    else tbody.insertBefore(tr, ref.nextSibling);
  }
}

// Thumb drag (ul.thumbs)
function attachThumbDnD(ul) {
  let src = null;
  ul.addEventListener('dragstart', (e)=>{
    const li = e.target.closest('li.thumb'); if (!li || li.hasAttribute('data-add')) return;
    src = li; li.classList.add('dragging');
    e.dataTransfer.effectAllowed='move';
    e.dataTransfer.setData('text/plain', li.dataset.id || '');
  });
  ul.addEventListener('dragend', ()=>{ if(src){src.classList.remove('dragging'); src=null;} });
  ul.addEventListener('dragover', (e)=>{
    e.preventDefault();
    if (!src) return;
    const over = e.target.closest('li.thumb'); if (!over || over===src || over.hasAttribute('data-add')) return;
    const rect = over.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height/2;
    over.parentNode.insertBefore(src, before ? over : over.nextSibling);
  });
}

// client-side sort helpers (mirror server)
function toTs(d,y){ if(d){const t=Date.parse(d); if(!Number.isNaN(t)) return t;} if(y){const t=Date.parse(String(y)+'-01-01'); if(!Number.isNaN(t)) return t;} return null; }
function stableSortClient(items, sortKey){
  const s = String(sortKey||'name_asc').toLowerCase();
  const dir = s.endsWith('_asc') ? 1 : -1;
  const key = s.split('_')[0];
  const cmpNullBottom = (a,b) => (a==null && b==null)?0 : (a==null?1 : (b==null?-1 : (a<b?-1:(a>b?1:0))));
  return items.map((m,i)=>({m,i})).sort((A,B)=>{
    const a=A.m,b=B.m; let c=0;
    if (key==='date') c = cmpNullBottom(toTs(a.releaseDate,a.year), toTs(b.releaseDate,b.year));
    else if (key==='rating' || key==='popularity') c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
    else if (key==='runtime') c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
    else c = (a.name||'').localeCompare(b.name||'');
    if (c===0){ c=(a.name||'').localeCompare(b.name||''); if(c===0) c=(a.id||'').localeCompare(b.id||''); if(c===0) c=A.i-B.i; }
    return c*dir;
  }).map(x=>x.m);
}

async function render() {
  const snapshotListEl = document.getElementById('snapshotList');
  if (snapshotListEl && !snapshotListEl.childElementCount && !snapshotListEl.textContent.trim()) {
    snapshotListEl.textContent = 'Loading lists…';
  }
  const container = document.getElementById('prefs');
  if (container && !container.childElementCount) {
    container.innerHTML = '<div class="mini muted">Loading custom lists…</div>';
  }

  let prefs;
  let lists;
  let draftItemOrders = {};
  if (customizeDraft && customizeDraft.prefs && customizeDraft.lists) {
    prefs = customizeDraft.prefs;
    lists = customizeDraft.lists;
    draftItemOrders = (customizeDraft.itemOrders && typeof customizeDraft.itemOrders === 'object') ? customizeDraft.itemOrders : {};
    customizeDraft = null;
  } else {
    try {
      [prefs, lists] = await Promise.all([getPrefs(), getLists()]);
    } catch (e) {
      if (snapshotListEl) snapshotListEl.textContent = 'Failed to load lists.';
      if (container) container.innerHTML = '<div class="mini muted">Failed to load custom lists.</div>';
      console.warn('[UI] render load failed:', e?.message || e);
      return;
    }
  }

  prefs.sources = prefs.sources || { users: [], lists: [], traktUsers: [] };
  const refresh = async () => { await render(); };
  const listCount = (lsid) => (lists[lsid]?.ids || []).length;

  function renderPills(id, arr, onRemove){
    const wrap = document.getElementById(id); wrap.innerHTML = '';
    (arr||[]).forEach((txt, idx)=>{
      const pill = el('span', {class:'pill'}, [
        el('span',{text:txt}),
        el('span',{class:'x',text:'✕'})
      ]);
      pill.querySelector('.x').onclick = ()=> onRemove(idx);
      wrap.appendChild(pill);
      wrap.appendChild(document.createTextNode(' '));
    });
    if (!arr || !arr.length) wrap.textContent = '(none)';
  }
  renderPills('userPills', prefs.sources?.users || [], (i)=>{
    prefs.sources.users.splice(i,1);
    saveAll('Saved');
  });
  renderPills('traktUserPills', prefs.sources?.traktUsers || [], (i)=>{
    prefs.sources.traktUsers.splice(i,1);
    saveAll('Saved');
  });
  renderPills('listPills', prefs.sources?.lists || [], (i)=>{
    prefs.sources.lists.splice(i,1);
    saveAll('Saved');
  });
  {
    const backupWrap = document.getElementById('backupConfigs');
    if (backupWrap) {
      backupWrap.innerHTML = '';
      const configs = prefs.backupConfigs || {};
      const entries = Object.values(configs);
      if (!entries.length) {
        backupWrap.textContent = '(none)';
      } else {
        entries.sort((a,b)=>String(a.name||a.id).localeCompare(String(b.name||b.id))).forEach(cfg=>{
          const sortLabel = cfg.sortKey || 'name_asc';
          const sortNote = sortLabel + (cfg.sortReverse ? ' (reversed)' : '');
          const title = (cfg.name || cfg.id) + ' (' + cfg.id + ')';
          const pill = el('span', {class:'pill'}, [
            el('span',{text: title + ' — ' + sortNote}),
            el('span',{class:'x',text:'✕'})
          ]);
          pill.querySelector('.x').onclick = async ()=>{
            await fetch('/api/link-backup?admin='+ADMIN, {
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ lsid: cfg.id, enabled: false })
            });
            await render();
          };
          backupWrap.appendChild(pill);
          backupWrap.appendChild(document.createTextNode(' '));
        });
      }
    }
  }

  // Blocked pills with Unblock action
  {
    const blockedWrap = document.getElementById('blockedPills');
    blockedWrap.innerHTML = '';
    const blocked = prefs.blocked || [];
    if (!blocked.length) blockedWrap.textContent = '(none)';
    blocked.forEach(lsid=>{
      const pill = el('span',{class:'pill'},[
        el('span',{text:lsid}),
        el('span',{class:'x',text:'Unblock'})
      ]);
      pill.querySelector('.x').onclick = async ()=>{
        await fetch('/api/unblock-list?admin='+ADMIN, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ lsid })
        });
        location.reload();
      };
      blockedWrap.appendChild(pill);
      blockedWrap.appendChild(document.createTextNode(' '));
    });
  }

  const displayName = (id) => (prefs.displayNames && prefs.displayNames[id]) || lists[id]?.name || id;
  const frozenMap = prefs.frozenLists || {};
  const customMap = prefs.customLists || {};

  async function renderSnapshotList() {
    const listWrap = document.getElementById('snapshotList');
    if (!listWrap) return;
    listWrap.innerHTML = '';
    const ids = Object.keys(lists);
    if (!ids.length) { listWrap.textContent = '(none)'; return; }
    const ordered = (prefs.order && prefs.order.length ? prefs.order.filter(id => lists[id]) : []);
    const missing = ids.filter(id => !ordered.includes(id));
    const finalOrder = ordered.concat(missing);
    finalOrder.forEach(id => {
      const li = el('li');
      const title = (frozenMap[id] ? '⭐ ' : '') + displayName(id);
      li.appendChild(el('b', { text: title }));
      li.appendChild(document.createTextNode(' '));
      li.appendChild(el('small', { text: '(' + listCount(id) + ' items)' }));
      if (lists[id]?.url) {
        const urlWrap = el('div');
        urlWrap.appendChild(el('small', { text: lists[id]?.url || '' }));
        li.appendChild(urlWrap);
      }
      listWrap.appendChild(li);
    });
  }

  async function renderDiscovered(forceRefresh = false) {
    const wrap = document.getElementById('discoveredList');
    const status = document.getElementById('discoveredStatus');
    if (!wrap) return;
    const renderItems = (items) => {
      wrap.innerHTML = '';
      if (!items.length) { wrap.textContent = '(none)'; return; }
      items.forEach(d => {
        const li = el('li');
        const row = el('div', { class: 'discovered-item' });
        const info = el('div');
        info.appendChild(el('b', { text: d.name || d.id }));
        const urlWrap = el('div');
        urlWrap.appendChild(el('small', { text: d.url || '' }));
        info.appendChild(urlWrap);
        row.appendChild(info);
        const blockBtn = el('button', { class: 'icon-btn danger', title: 'Block before sync', type: 'button' });
        blockBtn.innerHTML = '✕';
        blockBtn.onclick = async () => {
          if (!confirm('Block this list before it syncs?')) return;
          await fetch('/api/block-list?admin='+ADMIN, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ lsid: d.id })
          });
          await render();
        };
        row.appendChild(blockBtn);
        li.appendChild(row);
        wrap.appendChild(li);
      });
    };
    if (Array.isArray(discoveredCache)) {
      renderItems(discoveredCache);
    } else {
      wrap.textContent = '';
    }

    if (!forceRefresh) {
      if (status && !Array.isArray(discoveredCache)) status.textContent = 'Open the panel to discover lists.';
      return;
    }

    if (status) status.textContent = 'Discovering…';
    if (discoveredLoading) return;
    discoveredLoading = true;
    try {
      const data = await getDiscovered();
      const items = data?.lists || [];
      discoveredCache = items;
      renderItems(items);
      if (status) status.textContent = 'Done. ' + items.length + ' list(s) found.';
    } catch (e) {
      if (status) status.textContent = 'Discover failed; showing last results.';
    } finally {
      discoveredLoading = false;
    }
  }
  window.renderDiscovered = renderDiscovered;

  function wireTmdbControls() {
    const input = document.getElementById('tmdbKeyInput');
    const status = document.getElementById('tmdbStatus');
    const saveBtn = document.getElementById('tmdbSaveBtn');
    const verifyBtn = document.getElementById('tmdbVerifyBtn');
    if (!input || !status || !saveBtn || !verifyBtn) return;
    input.value = prefs.tmdbKey || '';

    const setStatus = (ok, text) => {
      status.textContent = text || '';
      status.className = 'mini muted';
      if (ok === true) status.className = 'status-pill ok';
      if (ok === false) status.className = 'status-pill bad';
    };
    if (prefs.tmdbKeyValid === true) setStatus(true, '✓ TMDB key verified and active');
    else if (prefs.tmdbKeyValid === false) setStatus(false, 'TMDB key invalid or unauthorized');
    else setStatus(null, 'Not verified yet.');

    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try {
        const r = await fetch('/api/tmdb-save?admin=' + ADMIN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: input.value })
        });
        if (!r.ok) throw new Error(await r.text());
        setStatus(null, 'TMDB key saved.');
      } catch (e) {
        setStatus(false, e.message || 'Failed to save TMDB key.');
      } finally {
        saveBtn.disabled = false;
      }
    };

    verifyBtn.onclick = async () => {
      verifyBtn.disabled = true;
      setStatus(null, 'Verifying…');
      try {
        const r = await fetch('/api/tmdb-verify?admin=' + ADMIN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: input.value })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) throw new Error(data.message || 'TMDB verification failed.');
        setStatus(true, data.message || 'TMDB key verified.');
      } catch (e) {
        setStatus(false, e.message || 'TMDB verification failed.');
      } finally {
        verifyBtn.disabled = false;
      }
    };
  }

  function wireBulkAdd() {
    const btn = document.getElementById('bulkAddBtn');
    const usersInput = document.getElementById('bulkUsers');
    const listsInput = document.getElementById('bulkLists');
    const status = document.getElementById('bulkStatus');
    if (!btn || !usersInput || !listsInput || !status) return;
    btn.onclick = async () => {
      btn.disabled = true;
      status.textContent = 'Adding…';
      try {
        const r = await fetch('/api/bulk-add-sources?admin=' + ADMIN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usersText: usersInput.value, listsText: listsInput.value })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.message || 'Bulk add failed');
        const errText = (data.errors || []).join(' | ');
        const syncText = data.syncQueued ? ' Sync started in background.' : '';
        status.textContent = 'Added: ' + data.added.users + ' users, ' + data.added.traktUsers + ' Trakt users, ' + data.added.lists + ' lists.' + syncText + (errText ? ' Errors: ' + errText : '');
        usersInput.value = '';
        listsInput.value = '';
        await renderDiscovered();
      } catch (e) {
        status.textContent = e.message || 'Bulk add failed.';
      } finally {
        btn.disabled = false;
      }
    };
  }

  wireTmdbControls();
  wireBulkAdd();
  renderSnapshotList();
  renderDiscovered();

  container.innerHTML = "";

  const hiddenSet = new Set(Array.isArray(prefs.hiddenLists) ? prefs.hiddenLists.filter(id => lists[id]) : []);
  const enabledSet = new Set((prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists)).filter(id => !hiddenSet.has(id)));
  const baseOrder = (prefs.order && prefs.order.length ? prefs.order.filter(id => lists[id]) : []);
  const missing   = Object.keys(lists).filter(id => !baseOrder.includes(id))
    .sort((a,b)=>( displayName(a).localeCompare(displayName(b)) ));
  const order = baseOrder.concat(missing);

  let showHiddenOnly = localStorage.getItem('showHiddenOnly') === 'true';
  const showHiddenBtn = document.getElementById('showHiddenBtn');
  const simpleModeBtn = document.getElementById('simpleModeBtn');
  const normalModeBtn = document.getElementById('normalModeBtn');
  const customizeLeadText = document.getElementById('customizeLeadText');
  const moveStyleToggle = document.getElementById('moveStyleToggle');
  const moveStyleHandleBtn = document.getElementById('moveStyleHandleBtn');
  const moveStyleArrowsBtn = document.getElementById('moveStyleArrowsBtn');

  const advancedToggle = document.getElementById('advancedToggle');
  const mergeBuilder = document.getElementById('mergeBuilder');
  const mergeSelection = new Set();
  const layoutMode = localStorage.getItem('customizeMode') === 'normal' ? 'normal' : 'simple';
  const isSimpleMode = layoutMode === 'simple';
  const normalMoveStyle = localStorage.getItem('normalMoveStyle') === 'arrows' ? 'arrows' : 'handle';
  const useArrowMove = !isSimpleMode && normalMoveStyle === 'arrows';
  document.body.classList.toggle('mode-simple', isSimpleMode);

  if (customizeLeadText) {
    customizeLeadText.textContent = isSimpleMode
      ? 'Simple mode is active. Drag with ☰ and use ⋯ for quick actions. Switch to Normal mode for full controls and list item drawers.'
      : 'Normal mode is active. You can reorder, open drawers, and manage advanced options for each list.';
  }

  if (moveStyleToggle) {
    moveStyleToggle.style.display = isSimpleMode ? 'none' : '';
    if (moveStyleHandleBtn) {
      moveStyleHandleBtn.classList.toggle('active', !useArrowMove);
      moveStyleHandleBtn.onclick = () => {
        if (isSimpleMode || !useArrowMove) return;
        stashCustomizeDraftFromUi();
        localStorage.setItem('normalMoveStyle', 'handle');
        render();
      };
    }
    if (moveStyleArrowsBtn) {
      moveStyleArrowsBtn.classList.toggle('active', useArrowMove);
      moveStyleArrowsBtn.onclick = () => {
        if (isSimpleMode || useArrowMove) return;
        stashCustomizeDraftFromUi();
        localStorage.setItem('normalMoveStyle', 'arrows');
        render();
      };
    }
  }

  function stashCustomizeDraftFromUi() {
    const visibleOrderNow = Array.from(tbody.querySelectorAll('tr[data-lsid]')).map(tr => tr.getAttribute('data-lsid'));
    const nextOrder = mergeVisibleOrderIntoFull(visibleOrderNow);
    const hidden = Array.from(hiddenSet);
    const enabled = nextOrder.filter(id => enabledSet.has(id) && !hiddenSet.has(id));
    const itemOrders = {};
    document.querySelectorAll('tr.drawer[data-drawer-for]').forEach((drawer) => {
      const drawerLsid = drawer.getAttribute('data-drawer-for');
      if (!drawerLsid) return;
      let ids = Array.from(drawer.querySelectorAll('ul.thumbs li.thumb[data-id]')).map(li => li.getAttribute('data-id')).filter(Boolean);
      if (!ids.length) return;
      const reversed = !!(prefs.sortReverse && prefs.sortReverse[drawerLsid]);
      if (reversed) ids = ids.slice().reverse();
      itemOrders[drawerLsid] = ids;
    });
    prefs.order = nextOrder;
    prefs.hiddenLists = hidden;
    prefs.enabled = enabled;
    customizeDraft = {
      prefs: JSON.parse(JSON.stringify(prefs)),
      lists,
      itemOrders
    };
  }

  if (simpleModeBtn) {
    simpleModeBtn.classList.toggle('active', isSimpleMode);
    simpleModeBtn.classList.toggle('hidden', isSimpleMode);
    simpleModeBtn.onclick = () => {
      if (isSimpleMode) return;
      stashCustomizeDraftFromUi();
      localStorage.setItem('customizeMode', 'simple');
      render();
    };
  }
  if (normalModeBtn) {
    normalModeBtn.classList.toggle('active', !isSimpleMode);
    normalModeBtn.classList.toggle('hidden', !isSimpleMode);
    normalModeBtn.onclick = () => {
      if (!isSimpleMode) return;
      stashCustomizeDraftFromUi();
      localStorage.setItem('customizeMode', 'normal');
      render();
    };
  }

  if (advancedToggle) {
    const saved = !isSimpleMode && localStorage.getItem('advancedMode') === 'true';
    advancedToggle.checked = saved;
    advancedToggle.disabled = isSimpleMode;
    advancedToggle.onchange = () => {
      localStorage.setItem('advancedMode', advancedToggle.checked ? 'true' : 'false');
      stashCustomizeDraftFromUi();
      render();
    };
  }
  if (isSimpleMode) {
    showHiddenOnly = false;
    localStorage.setItem('showHiddenOnly', 'false');
    localStorage.setItem('advancedMode', 'false');
  }
  if (showHiddenBtn) {
    showHiddenBtn.onclick = () => {
      showHiddenOnly = !showHiddenOnly;
      localStorage.setItem('showHiddenOnly', showHiddenOnly ? 'true' : 'false');
      stashCustomizeDraftFromUi();
      render();
    };
  }

  function updateAdvancedPanels() {
    const on = !isSimpleMode && advancedToggle && advancedToggle.checked;
    if (showHiddenBtn) {
      if (!on && showHiddenOnly) {
        showHiddenOnly = false;
        localStorage.setItem('showHiddenOnly', 'false');
      }
      showHiddenBtn.style.display = on ? '' : 'none';
      showHiddenBtn.textContent = showHiddenOnly ? 'Show normal lists' : 'Show hidden lists';
    }
    document.querySelectorAll('.hide-list-btn').forEach(btn => { btn.style.display = on ? '' : 'none'; });
    document.querySelectorAll('.adv-inline-btn').forEach(btn => {
      btn.style.display = on ? '' : 'none';
      if (!on) btn.setAttribute('aria-expanded', 'false');
    });
    if (!on) {
      document.querySelectorAll('tr.advanced-drawer').forEach(row => { row.style.display = 'none'; });
      document.querySelectorAll('tr.list-row').forEach(row => row.classList.remove('advanced-open'));
      document.querySelectorAll('.adv-inline-btn').forEach(btn => {
        btn.textContent = 'Show advanced options';
        btn.setAttribute('aria-expanded', 'false');
      });
    }
  }

  function visibleOrder() {
    return order.filter(lsid => showHiddenOnly ? hiddenSet.has(lsid) : !hiddenSet.has(lsid));
  }

  function renderMergeBuilder() {
    if (!mergeBuilder) return;
    const on = !isSimpleMode && advancedToggle && advancedToggle.checked;
    mergeBuilder.style.display = on ? '' : 'none';
    if (!on) return;
    mergeBuilder.innerHTML = '';
    mergeBuilder.appendChild(el('h4', { text: 'Merge Lists (up to 4)' }));
    const dropdown = el('details', { class: 'merge-dropdown' });
    const isOpen = localStorage.getItem('mergeBuilderOpen') === 'true';
    dropdown.open = isOpen;
    dropdown.ontoggle = () => {
      localStorage.setItem('mergeBuilderOpen', dropdown.open ? 'true' : 'false');
    };

    const summary = el('summary', { text: 'Merge list options' });
    dropdown.appendChild(summary);

    const body = el('div', { class: 'merge-dropdown-body' });
    body.appendChild(el('div', { class: 'mini muted', text: 'Select up to 4 lists to create a merged list. Duplicates are deduped by IMDb ID in first-appearance order.' }));
    const grid = el('div', { class: 'merge-grid' });
    visibleOrder().forEach(lsid => {
      const lab = el('label', { class: 'pill' });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = mergeSelection.has(lsid);
      cb.disabled = !mergeSelection.has(lsid) && mergeSelection.size >= 4;
      cb.onchange = () => {
        if (cb.checked) mergeSelection.add(lsid);
        else mergeSelection.delete(lsid);
        renderMergeBuilder();
      };
      lab.appendChild(cb);
      lab.appendChild(el('span', { text: displayName(lsid) }));
      grid.appendChild(lab);
    });
    body.appendChild(grid);
    const row = el('div', { class: 'rowtools' });
    const nameInput = el('input', { type: 'text', placeholder: 'Merged list name (optional)' });
    const mergeBtn = el('button', { text: 'Create merged list', type: 'button' });
    const status = el('span', { class: 'mini muted' });
    mergeBtn.onclick = async () => {
      mergeBtn.disabled = true;
      status.textContent = 'Merging…';
      try {
        const r = await fetch('/api/list-merge?admin=' + ADMIN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sources: Array.from(mergeSelection), name: nameInput.value })
        });
        if (!r.ok) throw new Error(await r.text());
        status.textContent = 'Merged list created.';
        mergeSelection.clear();
        await refresh();
      } catch (e) {
        status.textContent = e.message || 'Merge failed.';
      } finally {
        mergeBtn.disabled = false;
      }
    };
    row.appendChild(nameInput);
    row.appendChild(mergeBtn);
    row.appendChild(status);
    body.appendChild(row);
    dropdown.appendChild(body);
    mergeBuilder.appendChild(dropdown);
  }

  const table = el('table');
  const thead = el('thead', {}, [el('tr',{},[
    el('th',{text:'', class:'col-drawer'}),
    el('th',{text:'Move'}),
    el('th',{text:'Enabled'}),
    el('th',{text:'Stremlist', class:'col-streamlist'}),
    el('th',{text:isSimpleMode ? 'List' : 'List (id)'}),
    el('th',{text:'Items'}),
    el('th',{text:'Default sort', class:'col-sort'}),
    el('th',{text:'Backup', class:'col-backup'}),
    el('th',{text:isSimpleMode ? 'Actions' : 'Remove'})
  ])]);
  table.appendChild(thead);
  const tbody = el('tbody');

  function makeDrawer(lsid) {
    const tr = el('tr',{class:'drawer', 'data-drawer-for':lsid});
    const td = el('td',{colspan:'9'});
    td.appendChild(el('div',{text:'Loading…'}));
    tr.appendChild(td);

    getListItems(lsid).then(({items})=>{
      td.innerHTML = '';

      const imdbIndex = new Map((lists[lsid]?.ids || []).map((id,i)=>[id,i]));
      const imdbDateAsc  = (lists[lsid]?.orders?.date_asc  || []);
      const imdbDateDesc = (lists[lsid]?.orders?.date_desc || []);

      const tools = el('div', {class:'rowtools'});
      const saveBtn = el('button',{text:'Save order'});
      const resetBtn = el('button',{text:'Reset order', class:'order-reset-btn'});
      const resetAllBtn = el('button',{text:'Full reset'});
      tools.appendChild(saveBtn); tools.appendChild(resetBtn); tools.appendChild(resetAllBtn);

      const optsWrap = el('div',{class:'rowtools'});
      optsWrap.appendChild(el('span',{class:'mini muted', text:'Sort options shown in Stremio:'}));
      const current = (prefs.sortOptions && prefs.sortOptions[lsid] && prefs.sortOptions[lsid].length) ? new Set(prefs.sortOptions[lsid]) : new Set(SORT_OPTIONS);
      SORT_OPTIONS.forEach(opt=>{
        const lab = el('label',{class:'pill'});
        const cb = el('input',{type:'checkbox'}); cb.checked = current.has(opt);
        cb.onchange = ()=>{
          const arr = Array.from(optsWrap.querySelectorAll('input')).map((c,i)=>c.checked?SORT_OPTIONS[i]:null).filter(Boolean);
          prefs.sortOptions = prefs.sortOptions || {};
          prefs.sortOptions[lsid] = arr.length ? arr : SORT_OPTIONS.slice();
        };
        lab.appendChild(cb);
        lab.appendChild(el('span',{text:opt}));
        optsWrap.appendChild(lab);
      });

      td.appendChild(tools);
      td.appendChild(optsWrap);

      const searchWrap = el('div', { class: 'drawer-search-center' });
      const drawerSearch = createTitleSearchWidget({
        lsid,
        onAdd: async (imdbId) => {
          const r = await fetch('/api/list-add?admin=' + ADMIN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lsid, id: imdbId })
          });
          if (!r.ok) throw new Error(await r.text());
          await refresh();
        }
      });
      searchWrap.appendChild(drawerSearch.el);
      td.appendChild(searchWrap);

      const ul = el('ul',{class:'thumbs'});
      td.appendChild(ul);
      let tvMoveTile = null;
      function setTvMoveTile(nextLi) {
        if (tvMoveTile === nextLi) return;
        if (tvMoveTile) {
          tvMoveTile.classList.remove('tv-move-active');
          const prevHandle = tvMoveTile.querySelector('.move-handle-btn');
          if (prevHandle) prevHandle.setAttribute('aria-pressed', 'false');
        }
        tvMoveTile = nextLi || null;
        if (tvMoveTile) {
          tvMoveTile.classList.add('tv-move-active');
          const nextHandle = tvMoveTile.querySelector('.move-handle-btn');
          if (nextHandle) nextHandle.setAttribute('aria-pressed', 'true');
        }
      }

      function liFor(it){
        const li = el('li',{class:'thumb','data-id':it.id,draggable:'true'});
        li.appendChild(el('div',{class:'del',text:'×'}));
        li.querySelector('.del').onclick = async (e)=>{
          e.stopPropagation();
          if (!confirm('Remove this item from the list?')) return;
          await fetch('/api/list-remove?admin='+ADMIN, {method:'POST',headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid, id: it.id })});
          if (tvMoveTile === li) setTvMoveTile(null);
          await refresh();
        };

        const url = it.poster || it.background || '';
        const img = el('img',{src: url, alt:'', class:'thumb-img'});
        const wrap = el('div',{},[
          el('div',{class:'title',text: it.name || it.id}),
          el('div',{class:'id',text: it.id})
        ]);
        const moveBox = el('div',{class:'tile-move'});
        if (useArrowMove) {
          const upBtn = el('button',{type:'button',text:'↑'});
          const downBtn = el('button',{type:'button',text:'↓'});
          moveBox.appendChild(upBtn);
          moveBox.appendChild(downBtn);
          upBtn.onclick = (e)=>{ e.preventDefault(); moveThumb(li,-1); };
          downBtn.onclick = (e)=>{ e.preventDefault(); moveThumb(li,1); };
        } else {
          const moveHandle = el('span', {
            class:'drag-handle move-handle-btn',
            text:'☰',
            title:'Select item to move',
            tabindex:'0',
            role:'button',
            'aria-pressed':'false',
            'aria-label':'Select item and use arrows to move'
          });
          const toggleTvMoveTile = (e) => {
            if (e) e.preventDefault();
            if (tvMoveTile === li) setTvMoveTile(null);
            else setTvMoveTile(li);
          };
          moveHandle.addEventListener('click', toggleTvMoveTile);
          moveHandle.addEventListener('keydown', (e) => {
            const key = e.key;
            const isConfirm = key === 'Enter' || key === ' ' || key === 'Spacebar' || key === 'Select';
            if (isConfirm) {
              e.preventDefault();
              toggleTvMoveTile(e);
              return;
            }
            if (key === 'Escape') {
              e.preventDefault();
              setTvMoveTile(null);
              return;
            }
            if (tvMoveTile !== li) return;
            const moveDir = (key === 'ArrowUp' || key === 'ArrowLeft') ? -1 : ((key === 'ArrowDown' || key === 'ArrowRight') ? 1 : 0);
            if (!moveDir) return;
            e.preventDefault();
            moveThumb(li, moveDir);
            moveHandle.focus();
            li.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          });
          moveBox.appendChild(moveHandle);
        }
        li.appendChild(img); li.appendChild(wrap); li.appendChild(moveBox);
        return li;
      }

      function addSingleTile(){
        const li = el('li',{class:'thumb add','data-add':'1'});
        const box = el('div',{class:'addbox'},[
          el('div',{text:'Add by IMDb ID (tt...)'}),
          el('input',{type:'text',placeholder:'tt1234567 or IMDb URL', spellcheck:'false'})
        ]);
        li.appendChild(box);

        const input = box.querySelector('input');

        async function doAddReal(){
          const v = (input.value || '').trim();
          const m = v.match(/(tt\\d{7,})/i);
          if (!m) { alert('Enter a valid IMDb id'); return; }
          input.disabled = true;
          try {
            await fetch('/api/list-add?admin='+ADMIN, {
              method: 'POST',
              headers: { 'Content-Type':'application/json' },
              body: JSON.stringify({ lsid, id: m[1] })
            });
            input.value = '';
            await refresh();
          } finally {
            input.disabled = false;
          }
        }

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); doAddReal(); }
        });
        input.addEventListener('click', (e) => e.stopPropagation());

        return li;
      }


      function moveThumb(li, dir){
        const parent = li.parentNode;
        const items = Array.from(parent.querySelectorAll('li.thumb:not([data-add])'));
        const idx = items.indexOf(li);
        if (idx < 0 || items.length < 2) return;
        const tentative = idx + dir;
        const nextIdx = tentative < 0 ? items.length - 1 : (tentative >= items.length ? 0 : tentative);
        if (nextIdx === idx) return;
        const ref = items[nextIdx];
        if (dir < 0) {
          if (nextIdx === items.length - 1) parent.insertBefore(li, ref.nextSibling);
          else parent.insertBefore(li, ref);
        } else {
          if (nextIdx === 0) parent.insertBefore(li, ref);
          else parent.insertBefore(li, ref.nextSibling);
        }
      }

      const isReversed = () => !!(prefs.sortReverse && prefs.sortReverse[lsid]);
      const applyReverse = (arr) => isReversed() ? arr.slice().reverse() : arr;
      let forceResortAfterSortChange = false;

      function renderList(arr){
        ul.innerHTML = '';
        applyReverse(arr).forEach(it => ul.appendChild(liFor(it)));
        ul.appendChild(addSingleTile());
        attachThumbDnD(ul);
      }

      function orderFor(sortKey){
        if (sortKey === 'custom' && Array.isArray(draftItemOrders[lsid]) && draftItemOrders[lsid].length) {
          const pos = new Map(draftItemOrders[lsid].map((id, i) => [id, i]));
          return items.slice().sort((a,b)=>{
            const pa = pos.has(a.id)?pos.get(a.id):1e9;
            const pb = pos.has(b.id)?pos.get(b.id):1e9;
            return pa-pb;
          });
        }
        if (sortKey === 'custom' && prefs.customOrder && Array.isArray(prefs.customOrder[lsid]) && prefs.customOrder[lsid].length){
          const pos = new Map(prefs.customOrder[lsid].map((id,i)=>[id,i]));
          return items.slice().sort((a,b)=>{
            const pa = pos.has(a.id)?pos.get(a.id):1e9;
            const pb = pos.has(b.id)?pos.get(b.id):1e9;
            return pa-pb;
          });
        } else if (sortKey === 'imdb') {
          return items.slice().sort((a,b)=> (imdbIndex.get(a.id) ?? 1e9) - (imdbIndex.get(b.id) ?? 1e9));
        } else if (sortKey === 'date_asc' && imdbDateAsc.length){
          const pos = new Map(imdbDateAsc.map((id,i)=>[id,i]));
          if (forceResortAfterSortChange && items.some(it => !pos.has(it.id))) {
            return stableSortClient(items, 'date_asc');
          }
          return items.slice().sort((a,b)=> (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
        } else if (sortKey === 'date_desc' && imdbDateDesc.length){
          const pos = new Map(imdbDateDesc.map((id,i)=>[id,i]));
          if (forceResortAfterSortChange && items.some(it => !pos.has(it.id))) {
            return stableSortClient(items, 'date_desc');
          }
          return items.slice().sort((a,b)=> (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
        } else {
          return stableSortClient(items, sortKey);
        }
      }

      const def = (prefs.perListSort && prefs.perListSort[lsid]) || 'name_asc';
      renderList(orderFor(def));

      saveBtn.onclick = async ()=>{
        let ids = Array.from(ul.querySelectorAll('li.thumb[data-id]')).map(li=>li.getAttribute('data-id'));
        if (isReversed()) ids = ids.slice().reverse();
        saveBtn.disabled = true; resetBtn.disabled = true; resetAllBtn.disabled = true;
        try {
          await saveCustomOrder(lsid, ids);
          prefs.customOrder = prefs.customOrder || {};
          prefs.customOrder[lsid] = ids.slice();
          draftItemOrders[lsid] = ids.slice();
          const rowSel = document.querySelector('tr[data-lsid="'+lsid+'"] select');
          if (rowSel) rowSel.value = 'custom';
          prefs.perListSort = prefs.perListSort || {}; prefs.perListSort[lsid] = 'custom';
          saveBtn.textContent = "Saved ✓";
          setTimeout(()=> saveBtn.textContent = "Save order", 1500);
        } catch(e) {
          alert("Failed to save custom order");
        } finally {
          saveBtn.disabled = false; resetBtn.disabled = false; resetAllBtn.disabled = false;
        }
      };

      resetBtn.onclick = ()=>{
        forceResortAfterSortChange = tr.dataset.forceResort === '1';
        const rowSel = document.querySelector('tr[data-lsid="'+lsid+'"] select');
        const chosen = rowSel ? rowSel.value : (prefs.perListSort?.[lsid] || 'name_asc');
        renderList(orderFor(chosen));
        forceResortAfterSortChange = false;
        tr.dataset.forceResort = '0';
      };

      resetAllBtn.onclick = async ()=>{
        if (!confirm('Full reset: clear custom order and local add/remove edits for this list?')) return;
        resetAllBtn.disabled = true;
        try{
          await fetch('/api/list-reset?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid })});
          await refresh();
        } finally {
          resetAllBtn.disabled = false;
        }
      };

      async function refresh(){
        const r = await getListItems(lsid);
        items = r.items || [];
        const rowSel = document.querySelector('tr[data-lsid="'+lsid+'"] select');
        const chosen = rowSel ? rowSel.value : (prefs.perListSort?.[lsid] || 'name_asc');
        renderList(orderFor(chosen));
      }
    }).catch(()=>{ td.textContent = "Failed to load items."; });

    return tr;
  }

  function removeList(lsid){
    if (!confirm('Remove this list and block it from reappearing?')) return;
    fetch('/api/remove-list?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid })})
      .then(()=> location.reload())
      .catch(()=> alert('Remove failed'));
  }
  function deleteCustomList(lsid){
    if (!confirm('Delete this custom list permanently?')) return;
    fetch('/api/delete-custom-list?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid })})
      .then(()=> refresh())
      .catch(()=> alert('Delete failed'));
  }

  let tvMoveRow = null;
  function setTvMoveRow(nextRow) {
    if (tvMoveRow === nextRow) return;
    if (tvMoveRow) {
      tvMoveRow.classList.remove('tv-move-active');
      const prevHandle = tvMoveRow.querySelector('.move-handle-btn');
      if (prevHandle) prevHandle.setAttribute('aria-pressed', 'false');
    }
    tvMoveRow = nextRow || null;
    if (tvMoveRow) {
      tvMoveRow.classList.add('tv-move-active');
      const nextHandle = tvMoveRow.querySelector('.move-handle-btn');
      if (nextHandle) nextHandle.setAttribute('aria-pressed', 'true');
    }
  }

  function makeRow(lsid) {
    const L = lists[lsid];
    const customMeta = customMap[lsid];
    const isFrozen = !!frozenMap[lsid];
    const isCustom = !!customMeta;
    const isOfflineList = customMeta?.kind === 'offline';
    const tr = el('tr', {'data-lsid': lsid, draggable:'true', class:'list-row'});

    const chev = el('span',{
      class: isSimpleMode ? 'drag-handle' : 'chev',
      text: isSimpleMode ? '☰' : '▾',
      title: isSimpleMode ? 'Drag to reorder' : 'Open custom order & sort options'
    });
    const chevTd = el('td',{class:'chev-cell col-drawer'},[chev]);

    const isHidden = hiddenSet.has(lsid);
    const cb = el('input', {type:'checkbox'}); cb.checked = !isHidden && enabledSet.has(lsid);
    cb.disabled = isHidden;
    cb.title = isHidden ? 'Hidden lists are always disabled' : '';
    cb.addEventListener('change', ()=>{ if (cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); });

    const mainBtnSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" transform="rotate(45 12 12)"></rect><path d="M10.2 8.7a1 1 0 0 0-1.5.9v4.8a1 1 0 0 0 1.5.9l4.6-2.4a1 1 0 0 0 0-1.8l-4.6-2.4z" fill="currentColor"></path></svg>';
    const mainBtn = el('button', { type: 'button', class: 'icon-btn home', title: 'Toggle Stremlist save link' });
    mainBtn.innerHTML = mainBtnSvg;

    async function handleMainToggle(e) {
      if (e) e.preventDefault();
      prefs.mainLists = Array.isArray(prefs.mainLists) ? prefs.mainLists : [];
      if (prefs.mainLists.includes(lsid)) {
        prefs.mainLists = prefs.mainLists.filter(id => id !== lsid);
      } else {
        prefs.mainLists.push(lsid);
      }
      saveAll('Saved').then(refresh);
    }

    const moveWrap = el('div',{class:'move-btns'});
    if (useArrowMove) {
      const upBtn = el('button',{type:'button',text:'↑'});
      const downBtn = el('button',{type:'button',text:'↓'});
      moveWrap.appendChild(upBtn);
      moveWrap.appendChild(downBtn);
      upBtn.onclick = (e)=>{ e.preventDefault(); moveRowByButtons(tr,-1); };
      downBtn.onclick = (e)=>{ e.preventDefault(); moveRowByButtons(tr,1); };
    } else {
      const moveHandle = el('span', {
        class:'drag-handle move-handle-btn',
        text:'☰',
        title:'Select row to move',
        tabindex:'0',
        role:'button',
        'aria-pressed':'false',
        'aria-label':'Select row and use arrows to move'
      });
      const toggleTvMove = (e) => {
        if (e) e.preventDefault();
        if (tvMoveRow === tr) setTvMoveRow(null);
        else setTvMoveRow(tr);
      };
      moveHandle.addEventListener('click', toggleTvMove);
      moveHandle.addEventListener('keydown', (e) => {
        const key = e.key;
        const isConfirm = key === 'Enter' || key === ' ' || key === 'Spacebar' || key === 'Select';
        if (isConfirm) {
          e.preventDefault();
          toggleTvMove(e);
          return;
        }
        if (key === 'Escape') {
          e.preventDefault();
          setTvMoveRow(null);
          return;
        }
        if (tvMoveRow !== tr) return;
        const moveDir = (key === 'ArrowUp' || key === 'ArrowLeft') ? -1 : ((key === 'ArrowDown' || key === 'ArrowRight') ? 1 : 0);
        if (!moveDir) return;
        e.preventDefault();
        moveRowByButtons(tr, moveDir);
        moveHandle.focus();
        tr.scrollIntoView({ block: 'nearest' });
      });
      moveWrap.appendChild(moveHandle);
    }
    const moveTd = el('td',{},[moveWrap]);

    const nameCell = el('td',{});
    const rowTitle = (isFrozen ? '⭐ ' : '') + displayName(lsid);
    const nameLabel = el('div',{text:rowTitle, title:lsid});
    nameCell.appendChild(nameLabel);
    if (!isSimpleMode) nameCell.appendChild(el('small',{text:lsid}));
    if (customMeta?.kind === 'merged') {
      nameCell.appendChild(el('div', { class: 'mini muted', text: 'Merged from: ' + (customMeta.sources || []).map(id => displayName(id)).join(', ') }));
    }
    const advInlineBtn = el('button', { type: 'button', class: 'btn2 adv-inline-btn', text: 'Show advanced options', 'aria-expanded': 'false' });
    nameCell.appendChild(advInlineBtn);

    const hideBtn = el('button', { type: 'button', class: 'btn2 hide-list-btn', text: isHidden ? 'Unhide list' : 'Hide list' });
    hideBtn.onclick = async () => {
      hideBtn.disabled = true;
      const wasHidden = hiddenSet.has(lsid);
      if (wasHidden) {
        hiddenSet.delete(lsid);
      } else {
        hiddenSet.add(lsid);
        enabledSet.delete(lsid);
      }
      try {
        await saveAll('Saved');
        render();
      } catch (e) {
        if (wasHidden) hiddenSet.add(lsid);
        else hiddenSet.delete(lsid);
        alert('Failed to update hidden list state');
      } finally {
        hideBtn.disabled = false;
      }
    };

    const count = el('td',{text:String(listCount(lsid))});

    const sortSel = el('select');
    SORT_OPTIONS.forEach(o=>{
      const opt = el('option',{value:o,text:o});
      const def = (prefs.perListSort && prefs.perListSort[lsid]) || "name_asc";
      if (o===def) opt.setAttribute('selected','');
      sortSel.appendChild(opt);
    });
    const reverseBtn = el('button',{type:'button',class:'sort-reverse-btn',title:'Reverse order (last becomes first)'});
    function updateReverseBtn(){
      const active = !!(prefs.sortReverse && prefs.sortReverse[lsid]);
      reverseBtn.classList.toggle('active', active);
      reverseBtn.textContent = active ? '↓↑' : '↑↓';
    }
    reverseBtn.onclick = (e)=>{
      e.preventDefault();
      prefs.sortReverse = prefs.sortReverse || {};
      prefs.sortReverse[lsid] = !prefs.sortReverse[lsid];
      updateReverseBtn();
      const drawer = document.querySelector('tr[data-drawer-for="'+lsid+'"]');
      if (drawer && drawer.style.display !== "none") {
        const resetBtn = drawer.querySelector('.order-reset-btn');
        if (resetBtn) resetBtn.click();
      }
      saveAll('Saved');
    };
    updateReverseBtn();
    const sortWrap = el('div',{class:'sort-wrap'},[sortSel, reverseBtn]);
    sortSel.addEventListener('change', ()=>{
      prefs.perListSort = prefs.perListSort || {}; 
      prefs.perListSort[lsid] = sortSel.value;
      const drawer = document.querySelector('tr[data-drawer-for="'+lsid+'"]');
      if (drawer && drawer.style.display !== "none") {
        drawer.dataset.forceResort = '1';
        const resetBtn = drawer.querySelector('.order-reset-btn');
        if (resetBtn) resetBtn.click();
      }
      saveAll('Saved');
    });

    const removeLabel = isCustom ? 'Delete' : 'Remove';
    const rmBtn = el('button',{text: removeLabel, type:'button', class:'danger-btn'});
    rmBtn.onclick = ()=> {
      if (isCustom) return deleteCustomList(lsid);
      return removeList(lsid);
    };

    const backupValue = (L?.url || lsid);
    let backupActive = (prefs.linkBackups || []).includes(backupValue);
    const cloudBtn = el('button', { type: 'button', class: 'icon-btn cloud' });
    cloudBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 18a4.5 4.5 0 0 1-.5-8.98A6 6 0 0 1 18 8a4 4 0 0 1 .5 7.98H7.5zm8-6.5a1 1 0 0 0-1.7-.7l-1.3 1.3V9.5a1 1 0 1 0-2 0v2.6l-1.3-1.3a1 1 0 1 0-1.4 1.4l3 3a1 1 0 0 0 1.4 0l3-3a1 1 0 0 0 .3-.7z"/></svg>';
    const updateCloudBtn = (isActive) => {
      cloudBtn.classList.toggle('active', isActive);
      cloudBtn.title = isActive ? 'Un-backup this list' : 'Back up this list';
    };
    updateCloudBtn(backupActive);
    if (isCustom) {
      cloudBtn.disabled = true;
      cloudBtn.title = isOfflineList ? 'Offline lists use manual backups' : 'Custom lists use custom backups';
    } else {
      cloudBtn.onclick = async () => {
        cloudBtn.disabled = true;
        try {
          const drawer = document.querySelector('tr[data-drawer-for="'+lsid+'"]');
          if (drawer && drawer.style.display !== "none" && sortSel.value === 'custom') {
            const listEl = drawer.querySelector('ul.thumbs');
            if (listEl) {
              let ids = Array.from(listEl.querySelectorAll('li.thumb[data-id]')).map(li=>li.getAttribute('data-id'));
              if (prefs.sortReverse && prefs.sortReverse[lsid]) ids = ids.slice().reverse();
              await saveCustomOrder(lsid, ids);
            }
          }
          await fetch('/api/link-backup?admin=' + ADMIN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lsid, enabled: !backupActive })
          });
          backupActive = !backupActive;
          updateCloudBtn(backupActive);
          await refresh();
        } finally {
          cloudBtn.disabled = false;
        }
      };
    }

    const advancedPanel = el('div', { class: 'advanced-panel landscape' });
    const renameRow = el('div', { class: 'advanced-row' });
    const renameInput = el('input', { type: 'text', value: displayName(lsid), placeholder: 'Rename list' });
    const renameBtn = el('button', { type: 'button', text: 'Save name' });
    const renameStatus = el('span', { class: 'mini muted' });
    renameBtn.onclick = async () => {
      renameBtn.disabled = true;
      renameStatus.textContent = 'Saving…';
      try {
        const r = await fetch('/api/list-rename?admin=' + ADMIN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lsid, name: renameInput.value })
        });
        if (!r.ok) throw new Error(await r.text());
        renameStatus.textContent = 'Saved.';
        await refresh();
      } catch (e) {
        renameStatus.textContent = e.message || 'Rename failed.';
      } finally {
        renameBtn.disabled = false;
      }
    };
    renameRow.appendChild(renameInput);
    renameRow.appendChild(renameBtn);
    renameRow.appendChild(renameStatus);

    const actionRow = el('div', { class: 'advanced-row' });
    const dupBtn = el('button', { type: 'button', text: 'Duplicate' });
    const status = el('span', { class: 'mini muted' });
    let freezeBtn = null;
    if (!isOfflineList) {
      freezeBtn = el('button', { type: 'button', text: isFrozen ? 'Unfreeze' : 'Star / Freeze' });
      const syncBtn = el('button', { type: 'button', text: 'Sync/Update now' });
      freezeBtn.onclick = async () => {
        freezeBtn.disabled = true;
        status.textContent = isFrozen ? 'Unfreezing…' : 'Freezing…';
        try {
          const r = await fetch('/api/list-freeze?admin=' + ADMIN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lsid, frozen: !isFrozen })
          });
          if (!r.ok) throw new Error(await r.text());
          status.textContent = !isFrozen ? 'Frozen.' : 'Unfrozen.';
          await refresh();
        } catch (e) {
          status.textContent = e.message || 'Freeze failed.';
        } finally {
          freezeBtn.disabled = false;
        }
      };
      syncBtn.onclick = async () => {
        syncBtn.disabled = true;
        status.textContent = 'Syncing…';
        try {
          const r = await fetch('/api/list-manual-sync?admin=' + ADMIN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lsid })
          });
          if (!r.ok) throw new Error(await r.text());
          status.textContent = 'Synced.';
          await refresh();
        } catch (e) {
          status.textContent = e.message || 'Manual sync failed.';
        } finally {
          syncBtn.disabled = false;
        }
      };
      actionRow.appendChild(freezeBtn);
      if (isFrozen && (!customMeta || customMeta.kind === 'merged' || customMeta.kind === 'duplicate')) actionRow.appendChild(syncBtn);
    }
    dupBtn.onclick = async () => {
      dupBtn.disabled = true;
      status.textContent = 'Duplicating…';
      try {
        const r = await fetch('/api/list-duplicate?admin=' + ADMIN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lsid, name: '' })
        });
        if (!r.ok) throw new Error(await r.text());
        status.textContent = 'Duplicated.';
        await refresh();
      } catch (e) {
        status.textContent = e.message || 'Duplicate failed.';
      } finally {
        dupBtn.disabled = false;
      }
    };
    actionRow.appendChild(dupBtn);

    function makeSimpleActionsMenu() {
      const menu = el('details', { class: 'row-menu' });
      const summary = el('summary', { text: '⋯' });
      const list = el('div', { class: 'row-menu-list' });
      const streamlistAction = el('button', { type: 'button', text: 'Streamlist' });
      streamlistAction.onclick = async () => { menu.open = false; await handleMainToggle(); };
      const backupAction = el('button', { type: 'button', text: backupActive ? 'Unbackup' : 'Backup' });
      backupAction.disabled = !!cloudBtn.disabled;
      backupAction.onclick = async () => {
        if (cloudBtn.disabled || !cloudBtn.onclick) return;
        menu.open = false;
        await cloudBtn.onclick();
      };
      const freezeAction = el('button', { type: 'button', text: isFrozen ? 'Unfreeze' : 'Freeze' });
      freezeAction.disabled = !freezeBtn;
      freezeAction.onclick = async () => {
        if (!freezeBtn) return;
        menu.open = false;
        await freezeBtn.onclick();
      };
      const duplicateAction = el('button', { type: 'button', text: 'Duplicate' });
      duplicateAction.onclick = async () => { menu.open = false; await dupBtn.onclick(); };
      const removeAction = el('button', { type: 'button', text: removeLabel, class: 'warn' });
      removeAction.onclick = () => { menu.open = false; rmBtn.onclick(); };

      list.appendChild(streamlistAction);
      list.appendChild(backupAction);
      list.appendChild(freezeAction);
      list.appendChild(duplicateAction);
      list.appendChild(removeAction);
      menu.appendChild(summary);
      menu.appendChild(list);
      menu.addEventListener('toggle', () => {
        if (!menu.open) return;
        document.querySelectorAll('details.row-menu').forEach((d) => { if (d !== menu) d.open = false; });
      });
      return menu;
    }

    if (isOfflineList) {
      const csvBox = el('div', { class: 'csv-inline-box' });
      const csvTitle = el('span', { class: 'mini', text: 'Add CSV from IMDb (drag/drop or choose file)' });
      const csvInput = el('input', { type: 'file', accept: '.csv,text/csv' });
      const csvActions = el('div', { class: 'csv-actions' });
      const csvImportBtn = el('button', { type: 'button', text: 'Import CSV', disabled: 'disabled' });
      const csvCancelBtn = el('button', { type: 'button', text: 'Cancel CSV', class: 'btn2', disabled: 'disabled' });
      let pendingCsvText = '';
      let pendingCsvCount = 0;

      const setPending = (text, count) => {
        pendingCsvText = text || '';
        pendingCsvCount = Number.isFinite(count) ? count : 0;
        const has = !!pendingCsvText;
        csvImportBtn.disabled = !has;
        csvCancelBtn.disabled = !has;
      };
      const readCsv = async (file) => {
        if (!file) return;
        status.textContent = 'Reading CSV…';
        try {
          const text = await file.text();
          const count = parseCsvImdbIds(text).length;
          setPending(text, count);
          status.textContent = count
            ? ('CSV ready: ' + count + ' IMDb IDs. Click Import CSV.')
            : 'No IMDb IDs found in CSV.';
        } catch (e) {
          setPending('', 0);
          status.textContent = 'CSV read failed.';
        } finally {
          csvInput.value = '';
        }
      };

      csvInput.onchange = async () => {
        const file = csvInput.files && csvInput.files[0];
        await readCsv(file);
      };
      csvBox.addEventListener('dragover', (e) => {
        e.preventDefault();
        csvBox.classList.add('dragover');
      });
      csvBox.addEventListener('dragleave', () => csvBox.classList.remove('dragover'));
      csvBox.addEventListener('drop', async (e) => {
        e.preventDefault();
        csvBox.classList.remove('dragover');
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        await readCsv(file);
      });

      csvImportBtn.onclick = async () => {
        if (!pendingCsvText) return;
        status.textContent = 'Importing CSV…';
        try {
          const r = await fetch('/api/list-import-csv?admin=' + ADMIN, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lsid, csvText: pendingCsvText })
          });
          if (!r.ok) throw new Error(await r.text());
          status.textContent = 'CSV imported (' + pendingCsvCount + ' IDs).';
          setPending('', 0);
          await refresh();
        } catch (e) {
          status.textContent = e.message || 'CSV import failed.';
        }
      };
      csvCancelBtn.onclick = () => {
        setPending('', 0);
        csvInput.value = '';
        status.textContent = 'CSV selection cleared.';
      };

      csvActions.appendChild(csvImportBtn);
      csvActions.appendChild(csvCancelBtn);
      csvBox.appendChild(csvTitle);
      csvBox.appendChild(csvInput);
      csvBox.appendChild(csvActions);
      actionRow.appendChild(csvBox);
    }
    actionRow.appendChild(status);

    const bulkRow = el('div', { class: 'advanced-row stack' });
    const bulkBox = el('div', { class: 'imdb-box' });
    const bulkLabel = el('label', { class: 'mini bulk-label', text: 'Add those IMDb tt in bulk' });
    const bulkInput = el('textarea', { placeholder: 'tt1234567 tt7654321 or IMDb URLs', spellcheck: 'false' });
    const bulkBtn = el('button', { class: 'bulk-btn', type: 'button', text: 'Add bulk' });
    const bulkStatus = el('span', { class: 'mini muted bulk-status' });
    bulkBox.appendChild(bulkLabel);
    bulkBox.appendChild(bulkInput);
    bulkBox.appendChild(bulkBtn);
    bulkBox.appendChild(bulkStatus);
    bulkRow.appendChild(bulkBox);
    const doBulkAdd = async () => {
      const ids = parseImdbIdsFromText(bulkInput.value);
      if (!ids.length) { alert('Enter IMDb ids or IMDb URLs.'); return; }
      bulkBtn.disabled = true;
      bulkInput.disabled = true;
      bulkStatus.textContent = 'Adding…';
      try {
        const r = await fetch('/api/list-add-bulk?admin=' + ADMIN, {
          method: 'POST',
          headers: { 'Content-Type':'application/json' },
          body: JSON.stringify({ lsid, ids })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.message || 'Bulk add failed');
        const added = Number.isFinite(data.added) ? data.added : ids.length;
        const skipped = Number.isFinite(data.requested) ? Math.max(0, data.requested - added) : 0;
        bulkInput.value = '';
        bulkStatus.textContent = 'Added ' + added + ' item' + (added === 1 ? '' : 's') + (skipped ? ' (' + skipped + ' skipped).' : '.');
        await refresh();
      } catch (e) {
        bulkStatus.textContent = e.message || 'Bulk add failed.';
      } finally {
        bulkBtn.disabled = false;
        bulkInput.disabled = false;
      }
    };
    bulkBtn.addEventListener('click', (e) => {
      e.preventDefault();
      doBulkAdd();
    });
    bulkInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        doBulkAdd();
      }
    });

    const searchBox = el('div', { class: 'title-search-box' });
    const searchLabel = el('label', { class: 'mini bulk-label', text: 'Search TMDB by title, then add to list' });
    const searchRow = el('div', { class: 'title-search-row' });
    const searchInput = el('input', { type: 'text', placeholder: 'Type title name (e.g. Inception)', spellcheck: 'false' });
    const searchBtn = el('button', { class: 'bulk-btn', type: 'button', text: 'Search' });
    const searchStatus = el('span', { class: 'mini muted bulk-status' });
    const searchResults = el('div', { class: 'title-search-results' });
    searchRow.appendChild(searchInput);
    searchRow.appendChild(searchBtn);
    searchBox.appendChild(searchLabel);
    searchBox.appendChild(searchRow);
    searchBox.appendChild(searchStatus);
    searchBox.appendChild(searchResults);
    bulkBox.appendChild(searchBox);

    const renderSearchResults = (items) => {
      searchResults.innerHTML = '';
      if (!items.length) return;
      items.forEach((item) => {
        const row = el('div', { class: 'title-search-item' });
        const poster = document.createElement('img');
        poster.src = item.poster || 'https://images.metahub.space/poster/small/' + 'tt0111161' + '/img';
        poster.alt = item.title || 'Poster';
        const meta = el('div', { class: 'meta' });
        const typeLabel = item.mediaType === 'tv' ? 'Series' : 'Movie';
        const yearText = Number.isFinite(item.year) ? String(item.year) : 'Unknown year';
        const name = el('div', { class: 'name', text: (item.title || 'Untitled') + ' (' + yearText + ')' });
        const subtitle = el('div', { class: 'sub', text: typeLabel + (item.imdbId ? ' • ' + item.imdbId : ' • no IMDb id') });
        meta.appendChild(name);
        meta.appendChild(subtitle);

        const addBtn = el('button', { class: 'btn2', type: 'button', text: item.inList ? 'Added' : 'Add' });
        addBtn.disabled = !item.canAdd;
        addBtn.onclick = async () => {
          if (!item.imdbId) return;
          addBtn.disabled = true;
          addBtn.textContent = 'Adding…';
          searchStatus.textContent = 'Adding ' + item.imdbId + '…';
          try {
            const r = await fetch('/api/list-add?admin=' + ADMIN, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ lsid, id: item.imdbId })
            });
            if (!r.ok) throw new Error(await r.text());
            addBtn.textContent = 'Added';
            searchStatus.textContent = 'Added ' + item.imdbId + '.';
            await refresh();
          } catch (e) {
            addBtn.disabled = false;
            addBtn.textContent = 'Add';
            searchStatus.textContent = e.message || 'Add failed.';
          }
        };

        row.appendChild(poster);
        row.appendChild(meta);
        row.appendChild(addBtn);
        searchResults.appendChild(row);
      });
    };

    const doSearchTitles = async () => {
      const q = (searchInput.value || '').trim();
      if (!q) { alert('Enter a title to search.'); return; }
      searchBtn.disabled = true;
      searchInput.disabled = true;
      searchStatus.textContent = 'Searching…';
      searchResults.innerHTML = '';
      try {
        const r = await fetch('/api/list-search-title?admin=' + ADMIN + '&lsid=' + encodeURIComponent(lsid) + '&q=' + encodeURIComponent(q) + '&limit=5');
        const data = await r.json().catch(() => ({ items: [] }));
        if (!r.ok) throw new Error((data && data.message) || 'Title search failed');
        const items = Array.isArray(data.items) ? data.items : [];
        renderSearchResults(items);
        searchStatus.textContent = items.length ? ('Found ' + items.length + ' result' + (items.length === 1 ? '' : 's') + '.') : 'No matches found.';
      } catch (e) {
        searchStatus.textContent = e.message || 'Title search failed.';
      } finally {
        searchBtn.disabled = false;
        searchInput.disabled = false;
      }
    };
    searchBtn.addEventListener('click', (e) => {
      e.preventDefault();
      doSearchTitles();
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doSearchTitles();
      }
    });

    const mainRow = el('div', { class: 'advanced-row' });
    const mainBtnAdvanced = el('button', { type: 'button', class: 'icon-btn home', title: 'Toggle Stremlist save link' });
    mainBtnAdvanced.innerHTML = mainBtnSvg;
    const mainLabel = el('span', { class: 'mini muted', text: 'Stremlist save link' });
    function updateMainBtn() {
      const isMain = Array.isArray(prefs.mainLists) && prefs.mainLists.includes(lsid);
      const mainTitle = isMain ? 'Disable Stremlist save link' : 'Enable Stremlist save link';
      tr.classList.toggle('main', isMain);
      mainBtn.classList.toggle('active', isMain);
      mainBtn.classList.toggle('inactive', !isMain && Array.isArray(prefs.mainLists) && prefs.mainLists.length);
      mainBtn.setAttribute('aria-pressed', isMain ? 'true' : 'false');
      mainBtn.title = mainTitle;
      mainBtnAdvanced.classList.toggle('active', isMain);
      mainBtnAdvanced.classList.toggle('inactive', !isMain && Array.isArray(prefs.mainLists) && prefs.mainLists.length);
      mainBtnAdvanced.setAttribute('aria-pressed', isMain ? 'true' : 'false');
      mainBtnAdvanced.title = mainTitle;
    }
    updateMainBtn();
    mainBtn.onclick = handleMainToggle;
    mainBtnAdvanced.onclick = handleMainToggle;
    mainRow.appendChild(mainBtnAdvanced);
    mainRow.appendChild(mainLabel);

    advancedPanel.appendChild(renameRow);
    advancedPanel.appendChild(actionRow);
    if (!isOfflineList) advancedPanel.appendChild(mainRow);
    advancedPanel.appendChild(bulkRow);
    // Safety: never show TMDB title search inside advanced inline panel.
    advancedPanel.querySelectorAll('.title-search-box').forEach(node => node.remove());
    if (isCustom) {
      const customNote = el('div', { class: 'mini muted', text: isOfflineList ? 'Manual list: stored locally and deleted permanently.' : 'Custom list: delete removes it permanently.' });
      const noteWrap = el('div', { class: 'advanced-row' });
      noteWrap.appendChild(customNote);
      advancedPanel.appendChild(noteWrap);
    }

    const advancedDrawer = el('tr', { class: 'advanced-drawer', 'data-advanced-for': lsid });
    const advancedTd = el('td', { colspan: '9' });
    advancedTd.appendChild(advancedPanel);
    advancedDrawer.appendChild(advancedTd);
    advancedDrawer.style.display = 'none';

    tr.appendChild(chevTd);
    tr.appendChild(moveTd);
    const enabledCell = el('td');
    enabledCell.appendChild(cb);
    enabledCell.appendChild(hideBtn);
    tr.appendChild(enabledCell);
    tr.appendChild(el('td',{class:'col-streamlist'},[mainBtn]));
    tr.appendChild(nameCell);
    tr.appendChild(count);
    tr.appendChild(el('td',{class:'col-sort'},[sortWrap]));
    tr.appendChild(el('td',{class:'col-backup'},[cloudBtn]));
    const actionsTd = el('td');
    if (isSimpleMode) actionsTd.appendChild(makeSimpleActionsMenu());
    else actionsTd.appendChild(rmBtn);
    tr.appendChild(actionsTd);

    let drawer = null; let open = false;
    let advOpen = false;
    function orderDetailRows() {
      if (!tr.parentNode) return;
      let anchor = tr.nextSibling;
      if (advOpen) {
        tr.parentNode.insertBefore(advancedDrawer, anchor);
        advancedDrawer.style.display = '';
        anchor = advancedDrawer.nextSibling;
      } else {
        advancedDrawer.style.display = 'none';
      }
      if (drawer) {
        if (open) {
          tr.parentNode.insertBefore(drawer, anchor);
          drawer.style.display = '';
        } else {
          drawer.style.display = 'none';
        }
      }
    }
    advInlineBtn.onclick = () => {
      if (isSimpleMode || !(advancedToggle && advancedToggle.checked)) return;
      advOpen = !advOpen;
      advInlineBtn.textContent = advOpen ? 'Hide advanced options' : 'Show advanced options';
      advInlineBtn.setAttribute('aria-expanded', advOpen ? 'true' : 'false');
      tr.classList.toggle('advanced-open', advOpen);
      orderDetailRows();
    };

    chev.onclick = ()=>{
      if (isSimpleMode) return;
      open = !open;
      if (open) {
        chev.textContent = "▴";
        if (!drawer) drawer = makeDrawer(lsid);
      } else {
        chev.textContent = "▾";
      }
      orderDetailRows();
    };

    return tr;
  }

  visibleOrder().forEach(lsid => tbody.appendChild(makeRow(lsid)));
  table.appendChild(tbody);
  attachRowDnD(tbody);

  container.appendChild(table);
  updateAdvancedPanels();
  renderMergeBuilder();

  const msg = el('span',{class:'inline-note'});
  function mergeVisibleOrderIntoFull(nextVisibleOrder) {
    const visibleCheck = (id) => showHiddenOnly ? hiddenSet.has(id) : !hiddenSet.has(id);
    const queue = nextVisibleOrder.slice();
    const merged = order.map(id => (visibleCheck(id) ? (queue.shift() || id) : id));
    while (queue.length) merged.push(queue.shift());
    return Array.from(new Set(merged)).filter(id => lists[id]);
  }

  async function saveAll(text){
    const visibleOrderNow = Array.from(tbody.querySelectorAll('tr[data-lsid]')).map(tr => tr.getAttribute('data-lsid'));
    const newOrder = mergeVisibleOrderIntoFull(visibleOrderNow);
    const enabled = Array.from(enabledSet).filter(id => !hiddenSet.has(id));
    const body = {
      enabled,
      hiddenLists: Array.from(hiddenSet),
      order: newOrder,
      defaultList: prefs.defaultList || (enabled[0] || ""),
      mainLists: prefs.mainLists || [],
      perListSort: prefs.perListSort || {},
      sortReverse: prefs.sortReverse || {},
      sortOptions: prefs.sortOptions || {},
      upgradeEpisodes: prefs.upgradeEpisodes || false,
      sources: prefs.sources || {},
      blocked: prefs.blocked || [],
      reconcileFrozenState: true
    };
    msg.textContent = "Saving…";
    const r = await fetch('/api/prefs?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    const t = await r.text();
    msg.textContent = text || t || "Saved.";
    setTimeout(()=>{ msg.textContent = ""; }, 1800);
  }

  const saveWrap = el('div',{style:'margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap'});
  const saveBtn = el('button',{text:'Save', type:'button'});
  saveWrap.appendChild(saveBtn); saveWrap.appendChild(msg);
  container.appendChild(saveWrap);

  saveBtn.onclick = ()=> saveAll();
}

wireAddButtons();
wireOfflineCreatePanel(render);
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
      if (!Array.isArray(PREFS.mainLists)) {
        PREFS.mainLists = PREFS.mainList && isListId(PREFS.mainList) ? [PREFS.mainList] : [];
      }
      if (PREFS.mainList) delete PREFS.mainList;
      PREFS.hiddenLists = Array.isArray(PREFS.hiddenLists) ? PREFS.hiddenLists.filter(isListId) : [];
      FALLBK.clear(); if (snap.fallback) for (const [k,v] of Object.entries(snap.fallback)) FALLBK.set(k, v);
      CARD.clear();   if (snap.cards)    for (const [k,v] of Object.entries(snap.cards))    CARD.set(k, v);
      EP2SER.clear(); if (snap.ep2ser)   for (const [k,v] of Object.entries(snap.ep2ser))   EP2SER.set(k, v);
      MANIFEST_REV = snap.manifestRev || MANIFEST_REV;
      LAST_SYNC_AT = snap.lastSyncAt || 0;
      LAST_MANIFEST_KEY = manifestKey();

      for (const id of Object.keys(LISTS)) {
        if (LISTS[id]?.name) LISTS[id].name = sanitizeName(LISTS[id].name);
      }

      console.log("[BOOT] snapshot loaded");
    }
    await loadOfflineLists();
    await loadCustomLists();
    const frozenBackups = await loadFrozenBackups();
    let restored = false;
    if (frozenBackups.size) {
      for (const [lsid, data] of frozenBackups.entries()) {
        const missingList = !LISTS[lsid];
        const missingFrozen = !(PREFS.frozenLists && PREFS.frozenLists[lsid]);
        if (missingList || missingFrozen) {
          restoreFrozenBackupEntry(lsid, data);
          restored = true;
        }
      }
      if (restored) {
        LAST_MANIFEST_KEY = "";
        MANIFEST_REV++;
        await persistSnapshot();
        console.log("[BOOT] restored frozen lists from backup");
      }
    }

    const linkBackupConfigs = await loadLinkBackupConfigs();
    if (linkBackupConfigs.size) {
      let restoredLinks = false;
      for (const [lsid, data] of linkBackupConfigs.entries()) {
        const hasConfig = PREFS.backupConfigs && PREFS.backupConfigs[lsid];
        if (!hasConfig) {
          restoreLinkBackupConfigEntry(lsid, data);
          restoredLinks = true;
        }
      }
      if (restoredLinks) {
        LAST_MANIFEST_KEY = "";
        MANIFEST_REV++;
        await persistSnapshot();
        console.log("[BOOT] restored link backup configs");
      }
    }
  } catch(e){ console.warn("[BOOT] load snapshot failed:", e.message); }

  try {
    maybeBackgroundSync();
    scheduleNextSync();
  } catch (e) {
    console.warn("[BOOT] background sync failed:", e.message);
  }

  app.listen(PORT, HOST, () => {
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ""}`);
  });
})();
