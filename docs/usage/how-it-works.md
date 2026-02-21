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
- custom order save,
- source add/bulk add,
- block/unblock/remove list,
- sync/purge-sync,
- title search.

## Stream actions

For configured streamlists, stream endpoint returns actions to:
- add title to a list,
- remove title from a list,
- open Customize Layout deep-link.

If no streamlists are selected, response includes guidance + customize deep-link action.
