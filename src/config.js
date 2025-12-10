"use strict";

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
  .split(/[\,\s]+/).map(s => s.trim()).filter(s => /^ls\d{6,}$/i.test(s));

// Optional GitHub snapshot persistence
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || "";
const GITHUB_OWNER  = process.env.GITHUB_OWNER  || "";
const GITHUB_REPO   = process.env.GITHUB_REPO   || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GH_ENABLED    = !!(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO);
const SNAP_LOCAL    = "data/snapshot.json";

// NEW: Trakt support (public API key / client id)
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID || "";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/12.3.3";
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache"
};
const CINEMETA = "https://v3-cinemeta.strem.io";

// include "imdb" (raw list order) and mirror IMDb’s release-date order when available
const SORT_OPTIONS = [
  "custom","imdb","popularity",
  "date_asc","date_desc",
  "rating_asc","rating_desc",
  "runtime_asc","runtime_desc",
  "name_asc","name_desc"
];
const VALID_SORT = new Set(SORT_OPTIONS);

module.exports = {
  PORT,
  HOST,
  ADMIN_PASSWORD,
  SHARED_SECRET,
  IMDB_USER_URL,
  IMDB_SYNC_MINUTES,
  UPGRADE_EPISODES,
  IMDB_FETCH_RELEASE_ORDERS,
  IMDB_LIST_IDS,
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH,
  GH_ENABLED,
  SNAP_LOCAL,
  TRAKT_CLIENT_ID,
  UA,
  REQ_HEADERS,
  CINEMETA,
  SORT_OPTIONS,
  VALID_SORT
};
