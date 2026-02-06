# My Lists Stremio Addon (v12.4.0)

A Stremio addon that turns IMDb + Trakt sources into customizable catalogs, with an admin UI for sorting, freezing, editing, and backup management.

## What’s new in the current version
- **Supabase-backed persistence** for snapshot/manual/frozen/backup JSON data.
- **Manual discovered-list refresh** from Admin (`Discover now`) so discovery no longer auto-runs on every admin page load.
- **Background bulk-sync UX**: bulk add returns quickly and sync continues in background.
- **Improved admin loading states** for snapshot/custom-list sections.
- **Frozen state reconciliation** on save to prevent stale frozen files from resurrecting later.

---

## Features
- Import and sync from:
  - IMDb user lists and watchlists
  - IMDb list URLs / `ls...` ids
  - Trakt lists and watchlists
  - Trakt user list discovery
- Advanced admin controls:
  - Enable/disable catalogs
  - Drag/drop + button reorder
  - Per-list sort + sort options
  - Add/remove items in lists
  - Duplicate, merge, rename, and block lists
  - Freeze/unfreeze lists
  - Backup link configs
- Optional TMDB enrichment for posters/metadata.
- Save/Remove stream actions from Stremio.
- Manifest revision bump on save for easier Stremio refresh behavior.

---

## Requirements
- Node.js 18+

---

## Installation
```bash
npm install
npm start
```

Default server:
- Host: `0.0.0.0`
- Port: `7000` (or `PORT` env)

Admin URL:
```text
http://localhost:7000/admin?admin=YOUR_ADMIN_PASSWORD
```

Manifest URL:
```text
http://localhost:7000/manifest.json
```
If `SHARED_SECRET` is set:
```text
http://localhost:7000/manifest.json?key=YOUR_SHARED_SECRET
```

---

## Render deployment
Recommended service settings:
- **Build Command**: `npm install`
- **Start Command**: `node index.js`

Then add environment variables from the table below.

---

## Environment variables

### Required (recommended for production)
| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Protects admin UI/API. |
| `SHARED_SECRET` | Protects public addon routes (`manifest`, `catalog`, etc.). |
| `SUPABASE_URL` | Supabase project URL for storage persistence. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key used by server-side Supabase storage access. |
| `SUPABASE_BUCKET` | Bucket name used for addon JSON data (example: `mylist-data`). |

### Sync + source behavior
| Variable | Purpose |
|---|---|
| `IMDB_USER_URL` | Main IMDb `/user/.../lists/` source for discovery. |
| `IMDB_LIST_IDS` | Optional comma/space-separated fallback list ids (`ls...`). |
| `IMDB_SYNC_MINUTES` | Auto-sync interval. Set `0` to disable periodic sync. |
| `UPGRADE_EPISODES` | `true` to map episode entries to parent series where available. |
| `IMDB_FETCH_RELEASE_ORDERS` | `true` to mirror IMDb release-date ordering when available. |

### Optional integrations
| Variable | Purpose |
|---|---|
| `TRAKT_CLIENT_ID` | Required for Trakt API ingestion. |
| `TMDB_API_KEY` | Optional TMDB key/token for enhanced metadata. |
| `IMDB_COOKIE` | Optional cookie if IMDb access requires it in your environment. |

---

## Storage model (Supabase)
The addon stores JSON in your Supabase bucket using these logical paths:
- `snapshot.json`
- `manual/*.json`
- `frozen/*.json`
- `backup/*.json`
- plus index files such as `manual/index.json`, `frozen/index.json`, `backup/index.json`

The app also keeps local best-effort files under `data/`, but Supabase is the primary shared persistence layer.

---

## Admin usage guide

### 1) Add sources
Use Admin to add:
- IMDb user/list URLs
- Trakt users/lists
- bulk input (multiple lines)

Bulk add now returns quickly and shows a status message while sync runs in background.

### 2) Save layout & prefs
In **Customize**, configure:
- enabled lists
- order
- default list
- per-list sorting options

Click **Save** to persist state. Save now reconciles frozen backups to your current UI state.

### 3) Freeze / Unfreeze
- Freeze captures list ids/orders as a frozen snapshot.
- Unfreeze removes frozen state.
- On save, stale frozen Supabase files are reconciled/deleted to match the current UI state.

### 4) Discover behavior
The **Discovered** section is now manual:
- Open Discovered panel
- Click **Discover now**

Admin page reload alone does not automatically trigger discovery fetches for that panel.

---

## Troubleshooting

### Repeated IMDb 503 logs
- If they occur during scheduled sync, reduce/disable interval:
  - set `IMDB_SYNC_MINUTES=0` for no periodic rediscovery.
- Discovery from the admin panel is manual (`Discover now`).

### Lists appear empty briefly in Admin
- Current UI shows explicit loading states (`Loading lists...`, `Loading custom lists...`) while data fetches.

### Frozen lists come back after restart
- Ensure you **Save** after bulk unfreeze actions.
- Current version includes frozen-backup reconciliation during snapshot persistence.

### Supabase leftovers
- The addon now deletes stale frozen/manual/backup files during relevant flows and uses index/list fallback loading logic.

---

## Security notes
- Never commit secrets.
- Rotate `SUPABASE_SERVICE_ROLE_KEY` if exposed.
- Keep `ADMIN_PASSWORD` and `SHARED_SECRET` strong and private.

---

## High-level architecture
1. Source discovery/collection (IMDb/Trakt/custom)
2. Sync + normalization to IMDb ids
3. Snapshot persistence (local + Supabase)
4. Stremio routes serve manifest/catalog/meta/stream data

Key routes:
- `/manifest.json`
- `/catalog/:type/:id/:extra?.json`
- `/meta/:type/:id.json`
- `/stream/:type/:id.json`
- `/api/*` for admin actions
