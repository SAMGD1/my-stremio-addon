# How this addon works

This file explains the runtime logic and main routes.

## High-level pipeline

1. Read source configuration (env + admin prefs).
2. Discover lists from IMDb/Trakt and explicit links.
3. Fetch/normalize IDs into IMDb `tt...` where possible.
4. Build in-memory list state and persisted snapshot.
5. Serve Stremio addon routes (`manifest`, `catalog`, `meta`, `stream`).
6. Let admin UI manage list layout, edits, and advanced operations.

## Source discovery

Discovery combines:
- `IMDB_USER_URL`
- admin-added IMDb users
- explicit list links/IDs
- Trakt users
- optional fallback `IMDB_LIST_IDS`

Blocked lists are skipped.

## Sync model

- Periodic sync runs on `IMDB_SYNC_MINUTES` interval.
- Manual sync endpoints exist in admin API.
- `fullSync({ rediscover, force })` handles source refresh and list rebuild.

## Storage model

Two modes:

1. **Local-only mode**
   - uses files under `data/`.
2. **Supabase mode**
   - uses JSON object storage in configured bucket.

Snapshot + custom/frozen/manual/backup data are persisted and restored at startup.

## Stremio-facing routes

- `/manifest.json`
- `/catalog/:type/:id/:extra?.json`
- `/meta/:type/:id.json`
- `/stream/:type/:id.json`

If `SHARED_SECRET` is set, addon routes require `?key=`.

## Configure behavior

- `/configure` redirects to `/admin?admin=...` (main admin page).
- The stream action **"🌐 Streamlist a list (open Customize Layout)"** intentionally deep-links to `/admin?...&view=customize&mode=normal`.

## Admin UI deep-link handling

On `/admin`:
- `view=customize` auto-switches to Customize Layout section.
- `mode=normal` forces normal customize mode before render.

## List operations available in admin API

Examples include:
- prefs read/write,
- list rename/freeze/duplicate/merge,
- create offline list,
- CSV import,
- list item add/remove/reset,
- list bulk add (`/api/list-add-bulk`) with IMDb IDs,
- TMDB title search (`/api/list-search-title`),
- TMDB collection fetch (`/api/tmdb-collection-items`) and collection add (`/api/list-add-collection`),
- custom order save,
- source add/bulk add,
- block/unblock/remove list,
- sync/purge-sync,
- title search.

## TMDB collection implementation notes

- Search supports `movie`, `tv`, and `collection` modes.
- Collection search results include pre-resolved IMDb IDs for collection parts when available.
- Adding a collection calls TMDB collection endpoints, resolves IMDb IDs, and then appends only items not already in the target list.
- For offline/manual lists, collection items are written directly to the offline list payload.
- For synced lists, collection items are stored as list edits (`added` / `removed`) so upstream source data stays intact.

## Runtime API key controls

- TMDB key can be validated and saved at runtime from admin (`/api/tmdb-verify`, `/api/tmdb-save`).
- Trakt client id can be validated and saved at runtime from admin (`/api/trakt-verify`, `/api/trakt-save`).
- Keys are persisted in snapshot prefs so restart keeps the last saved values.

## Stream actions

For configured streamlists, stream endpoint returns actions to:
- add title to a list,
- remove title from a list,
- open Customize Layout deep-link.

If no streamlists are selected, response includes guidance + customize deep-link action.
