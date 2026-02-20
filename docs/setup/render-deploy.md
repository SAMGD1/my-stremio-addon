# Deploy on Render (step-by-step)

Use this for always-on hosting.

## 1) Push repo to GitHub

Render deploys from a git repo. Push this project to your GitHub account/org first.

## 2) Create Web Service in Render

1. Go to https://render.com
2. New → **Web Service**
3. Connect your GitHub repo
4. Choose branch

Recommended settings:
- **Runtime**: Node
- **Build Command**: `npm install`
- **Start Command**: `node index.js`

## 3) Add environment variables in Render

At minimum:

- `ADMIN_PASSWORD`
- `SHARED_SECRET`
- `PORT` (optional; Render usually injects one, app supports env `PORT`)

Recommended source/sync vars:
- `IMDB_USER_URL`
- `IMDB_SYNC_MINUTES`
- `UPGRADE_EPISODES=true`
- `IMDB_FETCH_RELEASE_ORDERS=true`
- `PRELOAD_CARDS=true`

Optional APIs:
- `TRAKT_CLIENT_ID`
- `TMDB_API_KEY`

Optional Supabase persistence:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_BUCKET`

## 4) Deploy and validate

After first deploy, open:
- `https://<your-service>.onrender.com/health` → should return `ok`
- `https://<your-service>.onrender.com/admin?admin=YOUR_ADMIN_PASSWORD`
- `https://<your-service>.onrender.com/manifest.json?key=YOUR_SHARED_SECRET`

## 5) Install in Stremio

Use hosted manifest URL:

```text
https://<your-service>.onrender.com/manifest.json?key=YOUR_SHARED_SECRET
```

## Recommended production pairing

Render (compute) + Supabase (persistent JSON storage) gives better durability across restarts/redeploys.

Set up Supabase first with guide:
- [`supabase-storage.md`](./supabase-storage.md)
