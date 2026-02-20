# Supabase storage setup (bucket + keys)

This addon can run local-only, but Supabase is recommended for persistent storage across restarts.

## 1) Create Supabase project

1. Go to https://supabase.com
2. Create a project
3. Wait until the project is ready

## 2) Create storage bucket

1. Open **Storage** in Supabase dashboard
2. Click **New bucket**
3. Bucket name: `mylist-data` (or your custom name)
4. Keep bucket **private** (recommended)

## 3) Get required values

From **Project Settings → API**:
- `SUPABASE_URL` = Project URL
- `SUPABASE_SERVICE_ROLE_KEY` = service role key (**secret**)

From Storage:
- `SUPABASE_BUCKET` = bucket name you created

## 4) Configure env vars

In `.env` (local) or host panel (Render):

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
SUPABASE_BUCKET=mylist-data
```

## 5) Restart app

Restart your app after saving env vars.

## 6) Confirm persistence is active

When Supabase is enabled, the startup log should not print the local-only warning.

The addon writes JSON objects under bucket paths such as:
- `snapshot.json`
- `manual/*.json`
- `custom/merged/*.json`
- `custom/duplicate/*.json`
- `frozen/*.json`
- `backup/*.json`
- index files under corresponding folders

## Security notes

- Never share `SUPABASE_SERVICE_ROLE_KEY`.
- Do not expose service-role key in client-side apps.
- Rotate key immediately if leaked.
