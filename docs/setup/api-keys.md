# Get Trakt and TMDB API keys

These integrations are optional, but unlock extra functionality.

## Trakt (`TRAKT_CLIENT_ID`)

Used for:
- Trakt list/watchlist ingestion
- Trakt user list discovery

### Steps

1. Sign in at https://trakt.tv
2. Go to API apps: https://trakt.tv/oauth/applications
3. Create a new application
4. Copy the **Client ID**
5. Set env var:

```env
TRAKT_CLIENT_ID=your_client_id_here
```

Restart app after updating.

## TMDB (`TMDB_API_KEY`)

Used for:
- TMDB key validation in admin
- title search-and-add widget
- richer metadata/posters fallback

### Steps

1. Sign in/create account at https://www.themoviedb.org
2. Go to account settings → API
3. Request API access if needed
4. Create API key/token
5. Set env var:

```env
TMDB_API_KEY=your_tmdb_key_or_token_here
```

Restart app after updating.

## Verify inside admin

Open admin and test flows:
- TMDB verify/save endpoints in settings/tools
- Trakt sources in Add Lists and sync
