# My Lists Stremio Addon

**Ever wanted to truly manage your lists?**

Are you tired of Trakt’s list and item limits? Don’t worry—use IMDb’s massive limits (10k items per list, unlimited lists), bring your Trakt lists along, and skip the Trakt subscription. This addon turns IMDb + Trakt into a flexible, cached Stremio experience that you fully control.

## What this addon does
- Turns IMDb lists, IMDb watchlists, Trakt lists, and Trakt watchlists into Stremio catalogs.
- Keeps your lists cached so Stremio loads fast.
- Lets you reorder, sort, freeze, merge, duplicate, and customize lists from a built-in admin console.
- Enriches posters and metadata using TMDB (optional).

## Features
- **IMDb + Trakt ingestion**: Import IMDb lists (including multi-page lists), IMDb watchlists, public Trakt lists, and Trakt watchlists. Episode entries can optionally be upgraded to their parent series for cleaner catalogs.
- **Source discovery**: Auto-discover lists from configured IMDb users, explicit IMDb/Trakt list URLs, IMDb chart/search shortcuts, and fallback list IDs.
- **Admin console**:
  - Snapshot dashboard of all lists.
  - Add sources in bulk (IMDb users, list URLs, Trakt users).
  - Customize catalogs with drag-and-drop **and** arrow buttons (remote friendly).
  - Rename, duplicate, freeze, merge, and back up lists.
  - Manual list sync and full purge + re-sync actions.
- **Per-list sorting**: IMDb order, IMDb popularity, IMDb release date (when available), rating/runtime/name/date, or custom order. Sort options are configurable per list.
- **Custom edits**: Add/remove items, edit custom order, and save list-specific overrides.
- **Stremio quick save/remove**: Pick a main list and get a Save/Remove stream link inside Stremio to add or remove the current title without leaving the app.
- **Manifest sync**: Saving preferences bumps the manifest revision so Stremio refreshes automatically.
- **TMDB enrichment**: Optional posters, backdrops, and descriptions using a TMDB API key.
- **Persistence options**: Save snapshot data locally and optionally to GitHub so your configuration survives restarts.
- **Secure sharing**: Optional shared secret required for addon routes (`manifest.json?key=...`).

## Requirements
- Node.js 18 or newer.

## Folder layout
This repo expects two main folders:
- **Code**: the repo root (`/workspace/my-stremio-addon` when running locally).
- **Data**: the `data/` folder inside the repo, used for snapshots, frozen lists, and backups.

Default data paths:
- `data/snapshot.json` (main state snapshot)
- `data/frozen/` (frozen list copies)
- `data/backup/` (manual backups)

> Create the `data/` folder before first run if it doesn’t exist; the addon will populate the files it needs.

## Local setup
```bash
npm install
npm start
```
The server listens on `PORT` (default `7000`) at `0.0.0.0`.

Open the admin console:
```
http://localhost:7000/admin?admin=Stremio_172
```
> Change `ADMIN_PASSWORD` in production.

### Install in Stremio
The manifest is served at:
```
http://localhost:7000/manifest.json
```
If you set `SHARED_SECRET`, append `?key=YOUR_SECRET`.

Use the **Install** button in the admin console or paste the manifest URL into Stremio.

## Render (or any hosted server) setup
1. Create a new Node.js web service.
2. Build command: `npm install`
3. Start command: `npm start`
4. Add environment variables (see below).
5. Deploy and open `https://YOUR-SERVICE.onrender.com/admin?admin=YOUR_PASSWORD`.

**Note:** Render’s filesystem is ephemeral unless you add a persistent disk. If you don’t use GitHub snapshot persistence, your lists/reset state may be lost on redeploy/restart.

### Hosting checklist (Render or other platforms)
- Ensure a writable `data/` directory is present (or mount a persistent disk to the repo root).
- Preserve `data/snapshot.json` between deploys **or** enable GitHub snapshot persistence.
- Expose the `/manifest.json` URL so Stremio can reach it externally.

## Key environment variables
| Variable | Purpose |
| --- | --- |
| `ADMIN_PASSWORD` | Password required for admin endpoints/UI. |
| `SHARED_SECRET` | Optional key required on addon routes (e.g., `manifest.json?key=...`). |
| `PORT`, `HOST` | Server port/host. |
| `IMDB_USER_URL` | Primary IMDb user `/lists` URL for auto-discovery. |
| `IMDB_LIST_IDS` | Comma/space-separated IMDb list IDs (`ls123...`) used as fallback sources. |
| `IMDB_SYNC_MINUTES` | Auto-sync interval in minutes (`0` disables). |
| `UPGRADE_EPISODES` | `true` to upgrade episodes to their parent series. |
| `IMDB_FETCH_RELEASE_ORDERS` | `true` to mirror IMDb release-date ordering. |
| `TRAKT_CLIENT_ID` | Public Trakt API key required for Trakt list support. |
| `TMDB_API_KEY` | TMDB v3 API key or v4 Read Access Token (for metadata). |
| `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH` | Enable optional snapshot persistence on GitHub. |

## API keys (Trakt + TMDB)
### Trakt
1. Create a Trakt account and go to **Settings → Your API Apps**.
2. Create a new app (a simple “Personal use” app is fine).
3. Copy the **Client ID** and set it as `TRAKT_CLIENT_ID`.

This addon only needs the public Client ID to read public Trakt lists and watchlists.

### TMDB
1. Create a TMDB account and open **Settings → API**.
2. Either create a **v3 API key** or a **v4 Read Access Token**.
3. Set the value as `TMDB_API_KEY`.

TMDB is optional. Without it, the addon falls back to Stremio/Cinemeta metadata.

## Adding sources
- **IMDb users**: Add `/user/urXXXXXX/lists/` URLs. The addon discovers all lists for the user and their public watchlist.
- **IMDb lists**: Provide full list URLs, watchlist URLs, or `ls` IDs. IMDb chart/search shortcuts can be provided as `imdb:chart-top`, `imdb:chart-toptv`, or `imdb:search:<slug>` to map to known chart/search URLs.
- **Trakt lists**: Provide Trakt list URLs (`https://trakt.tv/users/<user>/lists/<slug>`) or watchlist URLs (`https://trakt.tv/users/<user>/watchlist`). Official Trakt URLs like `https://trakt.tv/lists/official/<slug>` are normalized to the proper list key. You can also add Trakt usernames (or user URLs) under Trakt Users to harvest all their public lists and watchlist.

Use the **Add sources** page in the admin console to submit new IMDb users, IMDb/Trakt lists, or Trakt users. Added sources are saved and pulled on the next sync.

## Customizing catalogs
Open the **Customize** page to:
- Enable/disable catalogs and reorder them via drag-and-drop or the up/down buttons.
- Choose per-list default sort and which sort options appear in Stremio.
- Open a drawer for each list to adjust custom item order, reset edits, and add/remove items.
- Use the **Advanced options** panel to freeze lists, rename/duplicate lists, merge lists into a new frozen copy, and create backups.

Saving preferences bumps the manifest revision automatically so Stremio refreshes.

> **Important:** Whenever you add a new list or source, you may need to refresh the addon in Stremio. The easiest way is to reinstall the addon (paste the manifest URL again) or use an addon manager that can refresh/update installed addons.

## TMDB setup (Render)
Set a Render environment variable named `TMDB_API_KEY` and paste **one** of the following:
- **TMDB v4 Read Access Token** (recommended), e.g. a token that starts with `eyJ...`
- **TMDB v3 API key** (the short hex string from your TMDB settings)

The addon reads this environment variable at startup (no admin UI input), and TMDB becomes the default metadata source for posters, backdrops, and descriptions.

## Persistence and sync
Snapshot data (lists, preferences, cards) is stored locally in `data/snapshot.json` and optionally pushed to GitHub. Sync runs at startup and every `IMDB_SYNC_MINUTES` unless disabled.

## How the addon works (architecture overview)
### Core flow
1. **Source discovery** pulls IMDb lists/watchlists, Trakt lists/watchlists, and any custom sources you add in the admin UI.
2. **Sync** normalizes entries to IMDb IDs and optionally upgrades episodes to their parent series.
3. **Snapshot** writes the current state (lists, edits, preferences) to `data/snapshot.json`.
4. **Manifest** is generated from your enabled lists and preferences; Stremio reads it from `/manifest.json`.

### Key routes and functions
- **`/manifest.json`**: produces the Stremio manifest using your enabled lists and order.
- **`/catalog/:type/:id/:extra?.json`**: serves the list entries as Stremio catalogs.
- **`/meta/:type/:id.json`**: enriches titles with metadata (TMDB when configured).
- **`/stream/:type/:id.json`**: enables the Save/Remove stream actions.
- **Admin API (`/api/*`)**: powers the admin console (adding sources, sorting, list edits, sync, backups).

### Data persistence
- Local persistence uses `data/snapshot.json`.
- Optional GitHub persistence mirrors the snapshot to your repo on each save.
- “Frozen” lists are copied into `data/frozen/` so future syncs don’t change them.

## Manifest
The Stremio manifest is served at `/manifest.json` (append `?key=SHARED_SECRET` when set). Use the **Install** button in the admin console or copy the manifest URL into Stremio.
