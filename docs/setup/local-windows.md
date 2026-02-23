# Local setup on Windows (step-by-step)

This guide is for running the addon on your own Windows PC.

## 1) Install prerequisites

1. Install **Node.js 18+** (LTS recommended): https://nodejs.org/
2. Install **Git for Windows**: https://git-scm.com/download/win
3. Optional editor: **VS Code**: https://code.visualstudio.com/

Verify install in PowerShell:

```powershell
node -v
npm -v
git --version
```

## 2) Get the project

```powershell
git clone <YOUR_REPO_URL>
cd my-stremio-addon
```

## 3) Install dependencies

```powershell
npm install
```

## 4) Create environment file

Create a new file named `.env` in the project root, then set at least:

```env
ADMIN_PASSWORD=choose_a_strong_password
SHARED_SECRET=choose_another_secret
PORT=7000
```

Optional:

```env
IMDB_USER_URL=https://www.imdb.com/user/urXXXXXXX/lists/
TRAKT_CLIENT_ID=
TMDB_API_KEY=
# (optional, unlocks title + collection search/add)
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_BUCKET=mylist-data
```

> Leave Supabase vars empty for local-only mode.

## 5) Start server

```powershell
npm start
```

Expected console links include:
- `http://localhost:7000/admin?admin=...`
- `http://localhost:7000/manifest.json`

## 6) Open admin and configure lists

1. Open browser:
   `http://localhost:7000/admin?admin=YOUR_ADMIN_PASSWORD`
2. Add IMDb/Trakt sources.
3. Run sync (or wait for scheduled sync).
4. Configure list layout and streamlists.

## 7) Install addon in Stremio

Use:

```text
http://localhost:7000/manifest.json?key=YOUR_SHARED_SECRET
```

(If `SHARED_SECRET` is empty, `?key=` is not required.)

## 8) Keep it running

For local use, keep the terminal open. If you want always-on hosting, follow Render + Supabase guides:
- [`render-deploy.md`](./render-deploy.md)
- [`supabase-storage.md`](./supabase-storage.md)

## Troubleshooting (Windows)

### Port already in use
Set another port in `.env`, e.g. `PORT=7010`, then restart.

### npm install fails
- Check internet/firewall restrictions.
- Retry with:
  ```powershell
  npm cache clean --force
  npm install
  ```

### Admin says forbidden
Make sure URL has exact admin key:
`/admin?admin=YOUR_ADMIN_PASSWORD`

### Manifest forbidden in Stremio
If `SHARED_SECRET` is set, install using:
`/manifest.json?key=YOUR_SHARED_SECRET`
