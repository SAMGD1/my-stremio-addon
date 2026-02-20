# My Lists Stremio Addon (v12.4.0)

Turn IMDb + Trakt lists into Stremio catalogs you can fully control from a web admin panel.

This project supports:
- automatic list discovery from IMDb users and Trakt users,
- direct list source ingestion (IMDb `ls...`, watchlists, Trakt lists/watchlists),
- per-list sorting and custom order,
- one-click title add/remove from Stremio stream actions,
- optional TMDB metadata enrichment,
- local-only persistence or Supabase-backed persistence.

---

## Documentation map

Start here, then follow the guide you need:

- **How the app works (architecture + sync logic):** [`docs/usage/how-it-works.md`](docs/usage/how-it-works.md)
- **Local setup (Windows, step-by-step):** [`docs/setup/local-windows.md`](docs/setup/local-windows.md)
- **Render deployment (web service):** [`docs/setup/render-deploy.md`](docs/setup/render-deploy.md)
- **Supabase bucket setup (persistent storage):** [`docs/setup/supabase-storage.md`](docs/setup/supabase-storage.md)
- **Getting Trakt + TMDB API keys:** [`docs/setup/api-keys.md`](docs/setup/api-keys.md)

---

## Quick start (local)

```bash
npm install
cp .env.example .env
# edit .env
npm start
```

Then open:
- Admin: `http://localhost:7000/admin?admin=YOUR_ADMIN_PASSWORD`
- Manifest: `http://localhost:7000/manifest.json`
- Manifest with shared secret: `http://localhost:7000/manifest.json?key=YOUR_SHARED_SECRET`

> If `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are empty, the addon runs in local-only mode using `data/` files.

---

## Core behavior and recent feature notes

- `/configure` redirects to the **main admin page** (not customize deep-link).
- Stream action **"🌐 Streamlist a list (open Customize Layout)"** still deep-links to Customize Layout in normal mode.
- Admin page supports query handling:
  - `view=customize` opens the Customize Layout tab.
  - `mode=normal` forces customize mode to normal before render.

---

## Environment variables

### Required for secure production

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Admin UI/API auth key (`/admin?admin=...`). |
| `SHARED_SECRET` | Protects addon routes (`/manifest`, `/catalog`, `/meta`, `/stream`) via `?key=`. |

### Server

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `7000`). |

### Sync and source behavior

| Variable | Purpose |
|---|---|
| `IMDB_USER_URL` | Primary IMDb `/user/.../lists/` source for discovery. |
| `IMDB_LIST_IDS` | Optional fallback list ids (comma/space separated, `ls...`). |
| `IMDB_SYNC_MINUTES` | Auto-sync interval; `0` disables periodic sync. |
| `UPGRADE_EPISODES` | If `true`, maps episode IDs to parent series IDs when available. |
| `IMDB_FETCH_RELEASE_ORDERS` | If `true`, fetches IMDb release-date ordering for date sort parity. |
| `PRELOAD_CARDS` | If `true`, preloads metadata cards for faster browsing. |

### Optional APIs

| Variable | Purpose |
|---|---|
| `TRAKT_CLIENT_ID` | Enables Trakt list ingestion and Trakt user list discovery. |
| `TMDB_API_KEY` | Enables TMDB verification + title search/add + metadata enrichment. |

### Optional storage backend

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL for storage persistence. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key for bucket read/write. |
| `SUPABASE_BUCKET` | Bucket name (default `mylist-data`). |

---

## Main user flows

1. Add sources from admin (`IMDb user`, `IMDb list/watchlist`, `Trakt users/lists`).
2. Sync to discover/update lists.
3. Customize list visibility/order/defaults.
4. In Stremio, use stream actions to quickly add/remove titles to selected streamlists.
5. Use advanced tools for freeze, merge, duplicate, rename, block/unblock, backup links, manual/offline lists, and bulk imports.

For complete flow details, see [`docs/usage/how-it-works.md`](docs/usage/how-it-works.md).

---

## Security checklist

- Use a strong `ADMIN_PASSWORD`.
- Set `SHARED_SECRET` in production and install Stremio manifest using `?key=`.
- Never expose `SUPABASE_SERVICE_ROLE_KEY` in frontend/public clients.
- Rotate keys immediately if leaked.

---

## License

MIT
