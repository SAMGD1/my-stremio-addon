'use strict';

/*  My Lists – IMDb → Stremio catalogs (solid)
 *  v10.1
 *  - Discovers all public lists from IMDB_USER_URL (stable ls########)
 *  - Paginates items; de-dupes; optional episode→series upgrade
 *  - Metadata enrichment: Cinemeta → OMDb → TMDb → IMDb JSON-LD/OG
 *  - Admin UI: enable/disable, order, per-list default sort, default list
 *  - Save prefs without reinstall (manifest version auto-bumps)
 */

const express = require('express');

// ----------------- ENV -----------------
const PORT  = Number(process.env.PORT || 10000);
const HOST  = '0.0.0.0';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Stremio_172';
const SHARED_SECRET  = process.env.SHARED_SECRET  || '';
const IMDB_USER_URL  = process.env.IMDB_USER_URL  || ''; // e.g. https://www.imdb.com/user/ur136127821/lists/
const IMDB_SYNC_MIN  = Math.max(0, Number(process.env.IMDB_SYNC_MINUTES || 60));

// Optional accelerators (recommended)
const OMDB_API_KEY = process.env.OMDB_API_KEY || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

const UA       = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MyListsAddon/10.1';
const CINEMETA = 'https://v3-cinemeta.strem.io';

// ----------------- STATE -----------------
/** @type {Record<string,{id:string,name:string,url:string,ids:string[]}>} */
let LISTS = Object.create(null);

let PREFS = {
  enabled: [],           // [] => all discovered
  order: [],
  defaultList: '',
  perListSort: {},       // {lsid: "date_desc"|...}
  upgradeEpisodes: true
};

// caches
const BEST   = new Map(); // imdbId -> { kind:'movie'|'series', meta:Object }
const FALLBK = new Map(); // imdbId -> { name,poster,year,releaseDate,type }
const EP2SER = new Map(); // episode tt -> parent series tt
const CARD   = new Map(); // imdbId -> card used by catalogs

let MANIFEST_REV = 1;
let LAST_MANIFEST_KEY = '';
let LAST_SYNC_AT = 0;
let syncing = false;
let syncTimer = null;

// ----------------- UTILS -----------------
const isImdb  = v => /^tt\d{7,}$/i.test(String(v||''));
const isList  = v => /^ls\d{6,}$/i.test(String(v||''));
const nowIso  = () => new Date().toISOString();
const minToMs = m  => m * 60 * 1000;

async function text(url, accept='text/html,*/*'){
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': accept } });
  if(!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function json(url){
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if(!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}
const withParam = (u,k,v) => { const x=new URL(u); x.searchParams.set(k,v); return x.toString(); };

// ----------------- DISCOVERY -----------------
async function discoverListsFromUser(url){
  if(!url) return [];
  const html = await text(withParam(url,'_',Date.now()));
  // /list/ls##########/
  const re = /href="\/list\/(ls\d{6,})\/"/gi;
  const ids = new Set();
  const out = [];
  let m;
  while((m = re.exec(html))){
    const id = m[1];
    if(!ids.has(id)){ ids.add(id); out.push({ id, url: `https://www.imdb.com/list/${id}/` }); }
  }
  // names (cheap read of each list page header)
  await Promise.all(out.map(async L => {
    try { L.name = await fetchListName(L.url); } catch { L.name = L.id; }
  }));
  return out;
}

async function fetchListName(listUrl){
  const h = await text(withParam(listUrl,'_',Date.now()));
  const tries = [
    /<h1[^>]+data-testid="list-header-title"[^>]*>(.*?)<\/h1>/i,
    /<h1[^>]*class="[^"]*header[^"]*"[^>]*>(.*?)<\/h1>/i,
    /<title>(.*?)<\/title>/i
  ];
  for(const rx of tries){
    const m = h.match(rx);
    if(m){
      const name = m[1].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
      if(name) return name;
    }
  }
  return listUrl;
}

function parseTconsts(html){
  const seen = new Set();
  const out = [];
  let m;
  const re1 = /data-tconst="(tt\d{7,})"/gi;
  while((m = re1.exec(html))){
    const tt = m[1]; if(!seen.has(tt)){ seen.add(tt); out.push(tt); }
  }
  const re2 = /\/title\/(tt\d{7,})\//gi;
  while((m = re2.exec(html))){
    const tt = m[1]; if(!seen.has(tt)){ seen.add(tt); out.push(tt); }
  }
  return out;
}
function nextPage(html){
  let m = html.match(/<a[^>]+rel="next"[^>]+href="([^"]+)"/i);
  if(!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*class="[^"]*lister-page-next[^"]*"/i);
  if(!m) m = html.match(/<a[^>]+href="([^"]+)"[^>]*data-testid="pagination-next-page-button"[^>]*>/i);
  if(!m) return null;
  try { return new URL(m[1], 'https://www.imdb.com').toString(); } catch { return null; }
}
async function readAllItems(listUrl, maxPages=60){
  const modes = ['detail','grid','compact'];
  const seen = new Set(); const ids = [];
  for(const mode of modes){
    let url = withParam(listUrl,'mode',mode);
    let pages=0;
    while(url && pages<maxPages){
      let h; try { h = await text(withParam(url,'_',Date.now())); } catch { break; }
      const found = parseTconsts(h);
      let added = 0;
      for(const tt of found){ if(!seen.has(tt)){ seen.add(tt); ids.push(tt); added++; } }
      pages++;
      const nxt = nextPage(h);
      if(!nxt || added===0) break;
      url = nxt;
    }
    if(ids.length) break; // one successful mode is enough
  }
  return ids;
}

// ----------------- METADATA -----------------
async function cine(kind, id){
  try{
    const j = await json(`${CINEMETA}/meta/${kind}/${id}.json`);
    return j && j.meta ? j.meta : null;
  }catch{ return null; }
}
async function imdbLD(id){
  try{
    const html = await text(`https://www.imdb.com/title/${id}/`);
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if(m){ try { return JSON.parse(m[1]); } catch {} }
    // OG fallback
    const t = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    const p = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    return { name: t ? t[1] : undefined, image: p ? p[1] : undefined };
  }catch{ return null; }
}
const omdbById = id => OMDB_API_KEY
  ? json(`https://www.omdbapi.com/?apikey=${encodeURIComponent(OMDB_API_KEY)}&i=${encodeURIComponent(id)}`)
  : null;

const tmdbFind = id => TMDB_API_KEY
  ? json(`https://api.themoviedb.org/3/find/${encodeURIComponent(id)}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id`)
  : null;

async function epToSeries(id){
  if(EP2SER.has(id)) return EP2SER.get(id);
  const ld = await imdbLD(id);
  let seriesId = null;
  try{
    const node = Array.isArray(ld && ld['@graph'])
      ? ld['@graph'].find(x => x['@type']==='TVEpisode') : ld;
    const part = node && (node.partOfSeries || node.partOfTVSeries || (node.partOfSeason && node.partOfSeason.partOfSeries));
    if(part){
      const url = typeof part==='string' ? part : (part.url || part.sameAs || part['@id']);
      if(url){ const m = String(url).match(/tt\d{7,}/i); if(m) seriesId = m[0]; }
    }
  }catch{}
  if(seriesId) EP2SER.set(id, seriesId);
  return seriesId;
}

// build “best” record + enrich missing fields even if Cinemeta exists
async function bestMeta(id){
  if(BEST.has(id)) return BEST.get(id);

  // 1) Cinemeta movie→series
  let kind='movie', meta = await cine('movie', id);
  if(!meta){ kind='series'; meta = await cine('series', id); }
  if(meta){ /* keep going to overlay missing fields */ }

  // 2) OMDb
  const om = await omdbById(id);
  if(om && om.Response!=='False'){
    kind = om.Type==='series' ? 'series' : kind || 'movie';
    meta = overlay(meta, {
      name: om.Title,
      year: om.Year ? Number(String(om.Year).slice(0,4)) : undefined,
      imdbRating: om.imdbRating ? Number(om.imdbRating) : undefined,
      runtime: om.Runtime ? Number(String(om.Runtime).replace(/\D+/g,'')) : undefined,
      poster: om.Poster && om.Poster!=='N/A' ? om.Poster : undefined,
      released: om.Released && om.Released!=='N/A' ? om.Released : undefined
    });
  }

  // 3) TMDb
  const t = await tmdbFind(id);
  if(t && (t.movie_results?.length || t.tv_results?.length)){
    const tv = t.tv_results?.[0];
    const mv = t.movie_results?.[0];
    const sel = tv || mv;
    if(tv) kind = 'series';
    const poster = sel.poster_path ? `https://image.tmdb.org/t/p/w500${sel.poster_path}` : undefined;
    const year = sel.release_date ? Number(sel.release_date.slice(0,4))
               : sel.first_air_date ? Number(sel.first_air_date.slice(0,4)) : undefined;
    const released = sel.release_date || sel.first_air_date;
    meta = overlay(meta, {
      name: sel.name || sel.title,
      poster, year, released,
      description: sel.overview || undefined
    });
  }

  // 4) IMDb JSON-LD/OG
  const ld = await imdbLD(id);
  if(ld){
    try{
      const node = Array.isArray(ld['@graph'])
        ? ld['@graph'].find(x => (x['@id']||'').includes(`/title/${id}`)) || ld['@graph'][0]
        : ld;
      const name = node?.name || node?.headline || ld?.name;
      const img  = (typeof node?.image==='string' ? node.image : node?.image?.url) || ld?.image;
      const rel  = node?.datePublished || node?.startDate || node?.releaseDate;
      const yr   = rel ? Number(String(rel).slice(0,4)) : undefined;
      const ttype = (Array.isArray(node?.['@type']) ? node['@type'][0] : node?.['@type']) || '';
      if(/Series/i.test(ttype)) kind = 'series';
      meta = overlay(meta, { name, poster: img, released: rel, year: meta?.year ?? yr });
    }catch{}
  }

  // final
  const rec = { kind: kind || 'movie', meta: meta || null };
  BEST.set(id, rec);

  // cache fallback (helps cards even if Cinemeta exists with gaps)
  if(meta?.name || meta?.poster){
    FALLBK.set(id, {
      name: meta.name, poster: meta.poster,
      releaseDate: meta.released, year: meta.year,
      type: rec.kind
    });
  }
  return rec;
}

function overlay(base, extra){
  if(!extra) return base || null;
  const out = Object.assign({}, base || {});
  for(const k of Object.keys(extra)){
    if(out[k]==null || out[k]==='' || (k==='poster' && !out[k])) out[k] = extra[k];
  }
  return out;
}

function releaseTs(metaLike){
  const cand = [
    metaLike.released,
    metaLike.releaseDate,
    metaLike.firstAirDate,
    metaLike.startDate,
    metaLike.year ? `${metaLike.year}-01-01` : null
  ];
  for(const v of cand){
    if(!v) continue;
    const n = Date.parse(v);
    if(!Number.isNaN(n)) return n;
  }
  return null;
}

function buildCard(id){
  const rec = BEST.get(id) || { kind:null, meta:null };
  const m = rec.meta || {};
  const fb = FALLBK.get(id) || {};
  const merged = overlay({ }, overlay(fb, m));
  const ts = releaseTs(merged);
  return {
    id,
    type: rec.kind || merged.type || 'movie',
    name: merged.name || id,
    poster: merged.poster || undefined,
    imdbRating: merged.imdbRating ?? undefined,
    runtime: merged.runtime ?? undefined,
    year: merged.year ?? undefined,
    releaseDate: merged.released || merged.releaseDate || undefined,
    _ts: ts
  };
}

// ----------------- SYNC -----------------
function manifestKey(){
  const enabled = (PREFS.enabled && PREFS.enabled.length) ? PREFS.enabled : Object.keys(LISTS);
  const names = enabled.map(id => LISTS[id]?.name || id).sort().join('|');
  return `${enabled.join(',')}#${PREFS.order.join(',')}#${PREFS.defaultList}#${names}`;
}

async function fullSync({rediscover=true} = {}){
  if(syncing) return;
  syncing = true;
  try{
    // 1) discover lists
    let discovered = [];
    if(IMDB_USER_URL && rediscover){
      try { discovered = await discoverListsFromUser(IMDB_USER_URL); }
      catch(e){ console.warn('IMDb discovery failed:', e.message); }
    }
    const next = Object.create(null);
    const toFetch = [];

    const known = new Set(Object.keys(LISTS));
    for(const d of discovered){
      next[d.id] = { id:d.id, name:d.name||d.id, url:d.url, ids:[] };
      toFetch.push(d.id);
      known.delete(d.id);
    }
    // keep previous lists if IMDb is flaky
    for(const leftover of known){ next[leftover] = LISTS[leftover]; }

    // 2) read items
    const all = new Set();
    for(const id of Object.keys(next)){
      const url = next[id].url || `https://www.imdb.com/list/${id}/`;
      let ids = [];
      try { ids = await readAllItems(url); } catch {}
      next[id].ids = ids;
      ids.forEach(tt => all.add(tt));
    }

    // 3) optional episode -> series
    let universe = Array.from(all);
    if(PREFS.upgradeEpisodes){
      const remap = new Map(); // tt -> tt
      for(const tt of universe){
        let final = tt;
        // very cheap check via JSON-LD
        const ld = await imdbLD(tt);
        let isEpisode = false;
        try{
          const node = Array.isArray(ld && ld['@graph'])
            ? ld['@graph'].find(x => (x['@id']||'').includes(`/title/${tt}`))
            : ld;
          const ttype = (Array.isArray(node?.['@type']) ? node['@type'][0] : node?.['@type']) || '';
          isEpisode = /TVEpisode/i.test(ttype);
        }catch{}
        if(isEpisode){
          const ser = await epToSeries(tt);
          if(ser) final = ser;
        }
        remap.set(tt, final);
      }
      // apply to lists
      for(const id of Object.keys(next)){
        const seen = new Set();
        const out  = [];
        for(const x of next[id].ids){
          const y = remap.get(x) || x;
          if(!seen.has(y)){ seen.add(y); out.push(y); }
        }
        next[id].ids = out;
      }
      universe = Array.from(new Set([].concat(...Object.values(next).map(L => L.ids))));
    }

    // 4) preload + cards
    for(const tt of universe){ await bestMeta(tt); }
    CARD.clear();
    for(const tt of universe){ CARD.set(tt, buildCard(tt)); }

    LISTS = next;
    LAST_SYNC_AT = Date.now();

    const key = manifestKey();
    if(key !== LAST_MANIFEST_KEY){
      LAST_MANIFEST_KEY = key;
      MANIFEST_REV++;
      console.log('[SYNC] catalogs changed → manifest rev', MANIFEST_REV);
    }

    console.log(`[SYNC] ok – ${universe.length} ids across ${Object.keys(LISTS).length} lists in 0 min`);
  }catch(e){
    console.error('[SYNC] failed:', e);
  }finally{
    syncing = false;
  }
}

function scheduleSync(){
  if(syncTimer) clearTimeout(syncTimer);
  if(IMDB_SYNC_MIN <= 0) return;
  const delay = minToMs(IMDB_SYNC_MIN);
  syncTimer = setTimeout(async ()=>{
    await fullSync({rediscover:true});
    scheduleSync();
  }, delay);
}

// ----------------- SERVER -----------------
const app = express();
app.use((_,res,next)=>{ res.setHeader('Access-Control-Allow-Origin','*'); next(); });
app.use(express.json());

const addonAllowed = req => {
  if(!SHARED_SECRET) return true;
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return u.searchParams.get('key') === SHARED_SECRET;
};
const adminAllowed = req => {
  const u = new URL(req.originalUrl, `http://${req.headers.host}`);
  return (u.searchParams.get('admin') || req.headers['x-admin-key']) === ADMIN_PASSWORD;
};
const absoluteBase = req => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
};

app.get('/health', (_,res)=>res.status(200).send('ok'));

// ------- Manifest -------
const BASE_MANIFEST = {
  id: 'org.mylists.snapshot',
  // Keep proper SemVer (avoid 4-part versions to dodge Stremio parser trips)
  version: '10.1.0',
  name: 'My Lists',
  description: 'Your IMDb lists as instant catalogs (cached).',
  resources: ['catalog','meta'],
  types: ['movie','series'],
  idPrefixes: ['tt']
};

const effectiveEnabled = () => {
  const discovered = Object.keys(LISTS);
  if(!PREFS.enabled || !PREFS.enabled.length) return discovered;
  const set = new Set(discovered);
  return PREFS.enabled.filter(id => set.has(id));
};

function catalogs(){
  const enabled = effectiveEnabled();
  // order by prefs.order then by name
  const ord = new Map(enabled.map((id,i)=>[id,i+1000]));
  (PREFS.order||[]).forEach((id,idx)=>{ if(ord.has(id)) ord.set(id, idx); });
  const sorted = enabled.slice().sort((a,b)=>{
    const ia = ord.get(a) ?? 9999, ib = ord.get(b) ?? 9999;
    if(ia!==ib) return ia-ib;
    const na = LISTS[a]?.name || a, nb = LISTS[b]?.name || b;
    return na.localeCompare(nb);
  });
  return sorted.map(lsid => ({
    type: 'movie',                         // Stremio is fine; /meta handles both
    id: `list:${lsid}`,
    name: `🗂 ${LISTS[lsid]?.name || lsid}`,
    extraSupported: ['search','skip','limit','sort'],
    extra: [
      { name:'search' }, { name:'skip' }, { name:'limit' },
      { name:'sort', options:['date_asc','date_desc','rating_asc','rating_desc','runtime_asc','runtime_desc','name_asc','name_desc'] }
    ],
    posterShape: 'poster'
  }));
}

app.get('/manifest.json', (req,res)=>{
  try{
    if(!addonAllowed(req)) return res.status(403).send('Forbidden');
    res.setHeader('Cache-Control','no-store');
    const version = BASE_MANIFEST.version.replace(/(\d+)\.(\d+)\.(\d+)/, (_,a,b)=>`${a}.${Number(b)}.${MANIFEST_REV}`);
    res.json({ ...BASE_MANIFEST, version, catalogs: catalogs() });
  }catch(e){
    console.error('Manifest error:', e);
    res.status(500).send('Internal Server Error');
  }
});

// Helpers
function parseExtra(extraStr, queryObj){
  const params = new URLSearchParams(extraStr || '');
  const fromPath = Object.fromEntries(params.entries());
  return { ...fromPath, ...(queryObj || {}) };
}
function sortMetas(metas, key){
  const s = String(key || 'name_asc').toLowerCase();
  const dir = s.endsWith('_asc') ? 1 : -1;
  const field = s.split('_')[0];
  const cmpNullBottom = (a,b) => {
    const na = a==null, nb = b==null;
    if(na&&nb) return 0; if(na) return 1; if(nb) return -1;
    return a<b ? -1 : a>b ? 1 : 0;
  };
  return metas
    .map((m,i)=>({m,i}))
    .sort((A,B)=>{
      const a=A.m, b=B.m;
      let c=0;
      if(field==='date') c = cmpNullBottom(a._ts ?? null, b._ts ?? null);
      else if(field==='rating') c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
      else if(field==='runtime') c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
      else c = (a.name||'').localeCompare(b.name||'');
      if(c===0){ c = (a.name||'').localeCompare(b.name||''); if(c===0) c = (a.id||'').localeCompare(b.id||''); if(c===0) c = A.i - B.i; }
      return c*dir;
    })
    .map(x=>x.m);
}

// ------- Catalog -------
app.get('/catalog/:type/:id/:extra?.json', (req,res)=>{
  (async ()=>{
    try{
      if(!addonAllowed(req)) return res.status(403).send('Forbidden');
      res.setHeader('Cache-Control','no-store');

      const { id } = req.params;
      if(!id || !id.startsWith('list:')) return res.json({ metas: [] });

      const lsid = id.slice(5);
      const list = LISTS[lsid];
      if(!list) return res.json({ metas: [] });

      const extra = parseExtra(req.params.extra, req.query);
      const q     = String(extra.search || '').toLowerCase().trim();
      const sort  = (extra.sort || PREFS.perListSort?.[lsid] || 'name_asc').toLowerCase();
      const skip  = Math.max(0, Number(extra.skip || 0));
      const limit = Math.min(Number(extra.limit || 100), 200);

      let metas = (list.ids||[]).map(tt => CARD.get(tt) || buildCard(tt));

      if(q){
        metas = metas.filter(m =>
          (m.name||'').toLowerCase().includes(q) ||
          (m.id||'').toLowerCase().includes(q) ||
          (m.description||'').toLowerCase().includes(q)
        );
      }

      metas = sortMetas(metas, sort);
      res.json({ metas: metas.slice(skip, skip+limit) });
    }catch(e){
      console.error('Catalog error:', e);
      res.status(500).send('Internal Server Error');
    }
  })();
});

// ------- Meta -------
app.get('/meta/:type/:id.json', (req,res)=>{
  (async ()=>{
    try{
      if(!addonAllowed(req)) return res.status(403).send('Forbidden');
      res.setHeader('Cache-Control','no-store');
      const imdbId = req.params.id;
      if(!isImdb(imdbId))
        return res.json({ meta: { id: imdbId, type: 'movie', name: 'Unknown item' } });

      let rec = BEST.get(imdbId);
      if(!rec) rec = await bestMeta(imdbId);

      if(!rec || !rec.meta){
        const fb = FALLBK.get(imdbId) || {};
        return res.json({ meta: { id: imdbId, type: rec?.kind || fb.type || 'movie', name: fb.name || imdbId, poster: fb.poster || undefined } });
      }
      return res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
    }catch(e){
      console.error('Meta error:', e);
      res.status(500).send('Internal Server Error');
    }
  })();
});

// ------- Admin -------
app.get('/admin', async (req,res)=>{
  if(!adminAllowed(req)) return res.status(403).send('Forbidden. Append ?admin=YOUR_PASSWORD');
  const base = absoluteBase(req);
  const manifestUrl = `${base}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ''}`;

  let discovered = [];
  try { if(IMDB_USER_URL) discovered = await discoverListsFromUser(IMDB_USER_URL); } catch {}

  const rows = Object.keys(LISTS).map(id=>{
    const L = LISTS[id]; const n=(L.ids||[]).length;
    return `<li data-id="${id}"><b>${L.name||id}</b> <small>(${n} items)</small><br/><small>${L.url}</small></li>`;
  }).join('') || '<li>(none)</li>';

  const disc = discovered.map(d=>`<li><b>${d.name||d.id}</b><br/><small>${d.url}</small></li>`).join('') || '<li>(none found or IMDb unreachable right now).</li>';

  res.type('html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Admin</title>
<style>
body{font-family:system-ui,Segoe UI,Roboto,Arial;margin:24px;max-width:900px}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
button{padding:10px 16px;border:0;border-radius:8px;background:#2d6cdf;color:#fff;cursor:pointer}
small{color:#666}
.code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#f6f6f6;padding:4px 6px;border-radius:6px}
input[type="checkbox"]{transform:scale(1.2);margin-right:8px}
table{width:100%;border-collapse:collapse}
th,td{padding:8px;border-bottom:1px solid #eee;text-align:left}
select{padding:6px 8px;border:1px solid #ddd;border-radius:6px}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.badge{display:inline-block;background:#eee;border-radius:999px;padding:2px 8px;font-size:12px;margin-left:6px}
</style></head>
<body>
<h1>My Lists – Admin</h1>

<div class="card">
  <h3>Current Snapshot</h3>
  <ul>${rows}</ul>
  <p><small>Last sync: ${LAST_SYNC_AT ? new Date(LAST_SYNC_AT).toLocaleString() + " (" + Math.round((Date.now()-LAST_SYNC_AT)/60000) + " min ago)" : "never"}</small></p>
  <div class="row">
    <form method="POST" action="/api/sync?admin=${ADMIN_PASSWORD}">
      <button>Sync IMDb Lists Now</button>
    </form>
    <span class="badge">Auto-sync every ${IMDB_SYNC_MIN} min</span>
  </div>
</div>

<div class="card">
  <h3>Customize (enable/disable, order, defaults)</h3>
  <div id="prefs"></div>
  <div class="row" style="margin-top:10px"><button id="saveBtn">Save</button></div>
  <p id="saveMsg" style="color:#2d6cdf"></p>
</div>

<div class="card">
  <h3>Discovered at <span class="code">${IMDB_USER_URL || "(IMDB_USER_URL not set)"}</span></h3>
  <ul>${disc}</ul>
</div>

<div class="card">
  <h3>Manifest URL</h3>
  <p class="code">${manifestUrl}</p>
  <p><small>Version bumps automatically when catalogs change.</small></p>
</div>

<script>
async function getPrefs(){ const r = await fetch('/api/prefs?admin=${ADMIN_PASSWORD}'); return r.json(); }
async function getLists(){ const r = await fetch('/api/lists?admin=${ADMIN_PASSWORD}'); return r.json(); }

function el(tag, attrs={}, kids=[]){
  const e = document.createElement(tag);
  for(const k in attrs){ if(k==='text') e.textContent = attrs[k]; else if(k==='html') e.innerHTML=attrs[k]; else e.setAttribute(k, attrs[k]); }
  kids.forEach(c=>e.appendChild(c));
  return e;
}

async function render(){
  const prefs = await getPrefs();
  const lists = await getLists();
  const container = document.getElementById('prefs'); container.innerHTML = '';

  const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));
  const order = prefs.order && prefs.order.length ? prefs.order.slice() : Object.keys(lists);

  const table = el('table');
  const thead = el('thead',{},[el('tr',{},[
    el('th',{text:'Enabled'}), el('th',{text:'List (lsid)'}), el('th',{text:'Items'}), el('th',{text:'Order'}), el('th',{text:'Default sort'})
  ])]);
  table.appendChild(thead);
  const tbody = el('tbody');

  function row(lsid){
    const L = lists[lsid];
    const tr = el('tr');
    const cb = el('input',{type:'checkbox'}); cb.checked = enabledSet.has(lsid);
    cb.addEventListener('change',()=>{ if(cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); });

    const nameCell = el('td',{}); nameCell.appendChild(el('div',{text:(L.name||lsid)})); nameCell.appendChild(el('small',{text:lsid}));
    const count = el('td',{text:String((L.ids||[]).length)});

    const orderCell = el('td'); const up=el('button',{text:'↑'}); up.style.marginRight='6px'; const down=el('button',{text:'↓'});
    up.addEventListener('click',()=>{ const i=order.indexOf(lsid); if(i>0){ const t=order[i-1]; order[i-1]=order[i]; order[i]=t; render(); }});
    down.addEventListener('click',()=>{ const i=order.indexOf(lsid); if(i>=0 && i<order.length-1){ const t=order[i+1]; order[i+1]=order[i]; order[i]=t; render(); }});
    orderCell.appendChild(up); orderCell.appendChild(down);

    const sortSel = el('select');
    const opts=['date_asc','date_desc','rating_asc','rating_desc','runtime_asc','runtime_desc','name_asc','name_desc'];
    const def=(prefs.perListSort && prefs.perListSort[lsid]) || 'name_asc';
    opts.forEach(o=> sortSel.appendChild(el('option',{value:o,text:o, ...(o===def?{selected:''}:{})})));
    sortSel.addEventListener('change',()=>{ prefs.perListSort = prefs.perListSort || {}; prefs.perListSort[lsid]=sortSel.value; });

    tr.appendChild(el('td',{},[cb])); tr.appendChild(nameCell); tr.appendChild(count); tr.appendChild(orderCell); tr.appendChild(el('td',{},[sortSel]));
    return tr;
  }
  order.forEach(lsid=> tbody.appendChild(row(lsid)));
  table.appendChild(tbody);

  container.appendChild(el('div',{html:'<b>Default list:</b> '}));
  const defSel = el('select');
  order.forEach(lsid => defSel.appendChild(el('option',{value:lsid,text:(lists[lsid].name||lsid), ...(lsid===prefs.defaultList?{selected:''}:{})})));
  container.appendChild(defSel);

  container.appendChild(el('div',{style:'margin-top:8px'}));
  const epCb = el('input',{type:'checkbox'}); epCb.checked = !!prefs.upgradeEpisodes;
  container.appendChild(epCb); container.appendChild(el('span',{text:' Upgrade episodes to parent series'}));

  container.appendChild(el('div',{style:'margin-top:10px'})); container.appendChild(table);

  document.getElementById('saveBtn').onclick = async ()=>{
    const enabled = Array.from(enabledSet);
    const body = { enabled, order, defaultList:defSel.value, perListSort:prefs.perListSort||{}, upgradeEpisodes:epCb.checked };
    const r = await fetch('/api/prefs?admin=${ADMIN_PASSWORD}', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const t = await r.text();
    const p = document.getElementById('saveMsg'); p.textContent = t || 'Saved.'; setTimeout(()=>p.textContent='', 2500);
  };
}
render();
</script>
</body></html>`);
});

// admin APIs
app.get('/api/lists', (req,res)=>{ if(!adminAllowed(req)) return res.status(403).send('Forbidden'); res.json(LISTS); });
app.get('/api/prefs', (req,res)=>{ if(!adminAllowed(req)) return res.status(403).send('Forbidden'); res.json(PREFS); });

app.post('/api/prefs', (req,res)=>{
  (async ()=>{
    if(!adminAllowed(req)) return res.status(403).send('Forbidden');
    try{
      const b = req.body || {};
      PREFS.enabled         = Array.isArray(b.enabled) ? b.enabled.filter(isList) : [];
      PREFS.order           = Array.isArray(b.order)   ? b.order.filter(isList)   : [];
      PREFS.defaultList     = isList(b.defaultList) ? b.defaultList : '';
      PREFS.perListSort     = b.perListSort && typeof b.perListSort==='object' ? b.perListSort : {};
      PREFS.upgradeEpisodes = !!b.upgradeEpisodes;

      const key = manifestKey();
      if(key !== LAST_MANIFEST_KEY){ LAST_MANIFEST_KEY=key; MANIFEST_REV++; }
      res.status(200).send('Saved. Manifest rev ' + MANIFEST_REV);
    }catch(e){ res.status(500).send('Failed to save'); }
  })();
});

app.post('/api/sync', async (req,res)=>{
  if(!adminAllowed(req)) return res.status(403).send('Forbidden');
  await fullSync({rediscover:true});
  scheduleSync();
  res.status(200).send(`Synced at ${nowIso()}. <a href="/admin?admin=${ADMIN_PASSWORD}">Back</a>`);
});

// ----------------- BOOT -----------------
(async ()=>{
  await fullSync({rediscover:true});
  scheduleSync();
  app.listen(PORT, HOST, ()=>{
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${ADMIN_PASSWORD}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${SHARED_SECRET ? `?key=${SHARED_SECRET}` : ''}`);
  });
})();
