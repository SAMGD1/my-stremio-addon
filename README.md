# My Lists Stremio Addon (v12.4.0)

**Are you tired of Trakt’s tight list limits and caps?**
Move to IMDb and use virtually unlimited lists (IMDb supports large lists — commonly up to ~10,000 items per list), then control everything in Stremio with **My Lists Addon**.

This addon turns your IMDb and Trakt sources into fully customizable Stremio catalogs, with a powerful Admin UI for sorting, freezing, editing, and backups.

> **Responsibility notice**: This project is provided “as-is.” You are responsible for how you use it and for following the terms of any services you connect to. The addon does not grant you rights to content — it only organizes lists you already manage.

---

## Highlights
- **Use IMDb lists as unlimited, image-rich catalogs** in Stremio.
- **Customize layout and sorting** per list, including custom order.
- **Advanced tools**: bulk add, hide/unhide lists, freeze/unfreeze, duplicate, merge, and backups.
- **Optional TMDB enrichment** for posters and metadata.
- **Self-hosted**: run locally or deploy with Supabase + Render.

---

## What this addon does
1. Reads your configured **IMDb/Trakt list sources**.
2. Normalizes everything into **IMDb IDs (tt...)**.
3. Stores a snapshot and list metadata.
4. Serves Stremio catalogs via the standard addon routes.
5. Gives you a full Admin UI to customize everything.

---

## Features

### Source support
- **IMDb user lists** (from your public `/user/.../lists/` page)
- **IMDb list URLs** or `ls...` list IDs
- **IMDb watchlists**
- **Trakt lists and watchlists**
- **Trakt user list discovery**
- **Custom lists** (manual/offline, merged, duplicate)

### Admin controls
- Enable/disable catalogs
- Drag & drop ordering (plus up/down buttons)
- Per-list default sort + available sort options
- **Add/remove items in lists**
- **Bulk add IMDb IDs** (Advanced mode)
- Duplicate, merge, rename, or block lists
- Freeze/unfreeze list snapshots
- Backup link configuration
- Hide lists + hidden-only view toggle (Advanced mode)
- Per-list "Show advanced options" drawer toggle
- Create/manual list workflow with staged CSV import (Import/Cancel) and drag-drop hinting
- TMDB title search-and-add widget (when TMDB key is configured)

### Optional metadata
- **TMDB enrichment** for posters, ratings, and extra fields

---

## Requirements
- Node.js 18+

---

## Quick start (local)
```bash
npm install
cp .env.example .env
# edit .env
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

### Local-only mode (no Supabase)
If you leave `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` empty in `.env`, the app runs in local-only storage mode (`data/` files) without Supabase warning spam.

## Hosting online
You can run this locally **or** deploy it to a cloud host.

### Option A: Render (recommended for server hosting)
Recommended service settings:
- **Build Command**: `npm install`
- **Start Command**: `node index.js`

### Option B: Supabase (recommended for storage)
Supabase stores snapshots, frozen lists, and backups so your data persists even if the server restarts.

**You can use both Render + Supabase together** for a full online deployment.

---

## Environment variables

### Required (recommended for production)
| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Protects admin UI/API. |
| `SHARED_SECRET` | Protects public addon routes (`manifest`, `catalog`, etc.). |
| `SUPABASE_URL` | Supabase project URL for storage persistence. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase key for storage access. |
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

---

## Setup guide (step-by-step)

### 1) Create your lists
- Go to **IMDb** and create lists (public or unlisted).
- Optionally set a primary list or watchlist.

### 2) Get your list links
Use any of these formats:
- `https://www.imdb.com/user/urXXXXXXX/lists/`
- `https://www.imdb.com/list/lsXXXXXXX/`
- `lsXXXXXXX`

If using Trakt:
- `https://trakt.tv/users/USERNAME/lists`
- `https://trakt.tv/users/USERNAME/watchlist`

### 3) Start the server
```bash
npm start
```

### 4) Open Admin UI
```text
http://localhost:7000/admin?admin=YOUR_ADMIN_PASSWORD
```

### 5) Add sources
In **Add Lists**:
- Add a user list URL or list ID.
- Use bulk input for many sources at once.

### 6) Customize layout
In **Customize Layout**:
- Enable/disable lists
- Reorder lists
- Choose default list and sort
- Open **Advanced** for per-list tools

### 7) Create manual/custom lists
In **Customize Layout** → **Create list** you can:
- add items by IMDb `tt...` or URLs
- drag/drop or select IMDb CSV files
- stage CSV before commit with **Import CSV** / **Cancel CSV**
- use TMDB title search widget (if enabled) to find titles and add directly

---

## Advanced mode (per list)
Turn on **Advanced** in Customize Layout, then use **Show advanced options** on any row to open its drawer.

You can:
- Rename list
- Duplicate list
- Freeze/unfreeze list
- Manual sync (when frozen)
- Hide/unhide list
- Bulk add IMDb IDs
- TMDB title search + add (if TMDB is enabled)

Bulk add responds quickly and loads metadata in the background for a smoother experience.

---

## APIs & services used
You can enable these based on your needs:

### IMDb
- Used for list discovery and list item IDs.
- Works best with public or unlisted lists.

### Trakt
- Optional list source.
- Requires `TRAKT_CLIENT_ID`.

### TMDB
- Optional metadata enrichment (posters/ratings).
- Requires `TMDB_API_KEY`.

### Supabase
- Optional but recommended for storage persistence.

---

## Storage model (Supabase)
The addon stores JSON in your Supabase bucket using these paths:
- `snapshot.json`
- `manual/*.json`
- `custom/merged/*.json`
- `custom/duplicate/*.json`
- `frozen/*.json`
- `backup/*.json`
- plus index files such as `manual/index.json`, `custom/index.json`, `frozen/index.json`, `backup/index.json`

The app also keeps local files under `data/`, but Supabase is the primary shared persistence layer.

Custom merged/duplicate lists use their own custom backup storage (`custom/...`) and therefore do not use link-backup cloud toggle.

---

## Troubleshooting

### Lists appear empty briefly in Admin
- The UI shows loading states while data fetches finish.

### Sync feels slow
- Large lists can take time. Reduce the auto-sync interval or use manual sync.

### Frozen lists reappear after restart
- Save after unfreezing.

### Registry install errors
- If `npm install` fails due to restricted network policies, use a different network or preinstall dependencies.

---

## Security notes
- Never commit secrets.
- Rotate `SUPABASE_SERVICE_ROLE_KEY` if exposed.
- Keep `ADMIN_PASSWORD` and `SHARED_SECRET` strong and private.

---

## License
MIT. See [LICENSE](LICENSE).

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
