# My Lists Stremio Addon

This project turns IMDb and Trakt lists into cached Stremio catalogs with a built-in admin console.

## Features
- Imports IMDb lists (including multi-page lists) and public Trakt lists, with episode-to-series upgrades when desired.
- Discovers lists from configured IMDb users, explicit IMDb/Trakt list URLs, IMDb chart/search shortcuts, and optional fallback list IDs.
- Admin console provides snapshot view, add sources page, and customize page with drag-and-drop **and** arrow buttons for remote-friendly ordering.
- Per-list sort options (IMDb order, IMDb popularity when available, IMDb release date order when available, rating/runtime/name/date, or custom order) with manifest version bumping when catalogs change.
- Optional GitHub-based snapshot persistence so the addon remembers state across restarts.
- Catalogs use a custom "My Lists" catalog type so they appear in their own Discover section.
- Catalogs are exposed as movie catalogs to keep sort controls available on Stremio mobile clients.
- Per-list sort options (IMDb order, IMDb release date order when available, rating/runtime/name/date, or custom order) with manifest version bumping when catalogs change.
- Optional GitHub-based snapshot persistence so the addon remembers state across restarts.

## Requirements
- Node.js 18 or newer.

## Quick start
```bash
npm install
npm start
```
The server listens on `PORT` (default `7000`) at `0.0.0.0`. Open the admin console at:
```
http://localhost:7000/admin?admin=Stremio_172
```
Change the `ADMIN_PASSWORD` environment variable in production.

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
| `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH` | Enable optional snapshot persistence on GitHub. |

## Adding sources
- **IMDb users**: Add `/user/urXXXXXX/lists/` URLs. The addon discovers all lists for the user.
- **IMDb lists**: Provide full list URLs or `ls` IDs. IMDb chart/search shortcuts can be provided as `imdb:chart-top`, `imdb:chart-toptv`, or `imdb:search:<slug>` to map to known chart/search URLs.
- **Trakt lists**: Provide Trakt list URLs (`https://trakt.tv/users/<user>/lists/<slug>`). Official Trakt URLs like `https://trakt.tv/lists/official/<slug>` are normalized to the proper list key. You can also add Trakt usernames (or user URLs) under Trakt Users to harvest all their public lists.

Use the **Add sources** page in the admin console to submit new IMDb users, IMDb/Trakt lists, or Trakt users. Added sources are saved and pulled on the next sync.

## Customizing catalogs
Open the **Customize** page to:
- Enable/disable catalogs and reorder them via drag-and-drop or the up/down buttons (useful on remotes).
- Choose per-list default sort and which sort options appear in Stremio.
- Open a drawer for each list to adjust custom item order, reset edits, and add/remove items.

Saving preferences bumps the manifest revision automatically so Stremio refreshes.

## Persistence and sync
Snapshot data (lists, preferences, cards) is stored locally in `data/snapshot.json` and optionally pushed to GitHub. Sync runs at startup and every `IMDB_SYNC_MINUTES` unless disabled.

## Manifest
The Stremio manifest is served at `/manifest.json` (append `?key=SHARED_SECRET` when set). Use the **Install** button in the admin console or copy the manifest URL into Stremio.
