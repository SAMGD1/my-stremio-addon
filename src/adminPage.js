"use strict";

function renderAdminPage({
  adminPassword,
  baseUrl,
  manifestUrl,
  discovered = [],
  lists = {},
  lastSyncText,
  imdbSyncMinutes,
  sharedSecret,
  sortOptions = []
}) {
  const rows = Object.keys(lists).map(id => {
    const L = lists[id]; const count = (L.ids || []).length;
    return `<li><b>${L.name || id}</b> <small>(${count} items)</small><br/><small>${L.url || ""}</small></li>`;
  }).join("") || "<li>(none)</li>";

  const disc = discovered.map(d => `<li><b>${d.name || d.id}</b><br/><small>${d.url}</small></li>`).join("") || "<li>(none)</li>";

  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>My Lists – Admin</title>
<style>
  :root{
    color-scheme:light;
    --bg:#050415;
    --bg2:#0f0d1a;
    --card:#141129;
    --muted:#9aa0b4;
    --text:#f7f7fb;
    --accent:#6c5ce7;
    --accent2:#8b7cf7;
    --accent-soft:rgba(108,92,231,.18);
    --border:#262145;
    --danger:#ff7675;
  }
  body{
    font-family:system-ui,Segoe UI,Roboto,Arial;
    margin:0;
    background:radial-gradient(circle at top,#2f2165 0,#050415 48%,#02010a 100%);
    color:var(--text);
  }
  .wrap{max-width:1100px;margin:24px auto;padding:0 16px}
  .hero{padding:20px 0 12px}
  h1{margin:0 0 4px;font-weight:700;font-size:26px;letter-spacing:.01em}
  .subtitle{color:var(--muted);font-size:14px}
  .grid{display:grid;gap:16px;grid-template-columns:1fr}
  @media(min-width:980px){ .grid{grid-template-columns:1.1fr .9fr} }
  .card{
    border:1px solid var(--border);
    border-radius:18px;
    padding:16px 18px;
    background:linear-gradient(145deg,rgba(17,14,39,.96),rgba(8,6,25,.98));
    box-shadow:0 18px 40px rgba(0,0,0,.55);
  }
  h3{margin:0 0 8px;font-size:17px}
  h4{margin:10px 0 4px;font-size:14px}
  button{
    padding:9px 14px;
    border:0;
    border-radius:999px;
    background:var(--accent);
    color:#fff;
    cursor:pointer;
    font-size:13px;
    display:inline-flex;
    align-items:center;
    gap:6px;
    box-shadow:0 6px 16px rgba(108,92,231,.55);
  }
  button.btn2{background:var(--accent2);} 
  button:disabled{opacity:.5;cursor:default;box-shadow:none}
  small{color:var(--muted)}
  .code{
    font-family:ui-monospace,Menlo,Consolas,monospace;
    background:#1c1837;
    color:#d6d3ff;
    padding:4px 6px;
    border-radius:6px;
    font-size:12px;
    word-break:break-all;
  }
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
  th,td{padding:8px 6px;border-bottom:1px solid rgba(38,33,69,.8);text-align:left;vertical-align:top}
  th{font-weight:600;color:#d7d1ff;font-size:12px}
  tr:hover td{background:rgba(17,14,40,.7);}
  .muted{color:var(--muted)}
  .chev{cursor:pointer;font-size:16px;line-height:1;user-select:none}
  .drawer{background:#120f25}
  .thumbs{
    display:grid;
    grid-template-columns:repeat(auto-fill,minmax(220px,1fr));
    gap:10px;
    margin:12px 0;
    padding:0;
    list-style:none;
  }
  .thumb{
    position:relative;
    display:flex;
    gap:10px;
    align-items:center;
    border:1px solid var(--border);
    background:#1a1636;
    border-radius:12px;
    padding:6px 8px;
  }
  .thumb-img{
    object-fit:cover;
    border-radius:6px;
    background:#2a244e;
    flex-shrink:0;
    width:52px;
    height:78px;
  }
  .thumb .title{font-size:14px}
  .thumb .id{font-size:11px;color:var(--muted)}
  .thumb[draggable="true"]{cursor:grab}
  .thumb.dragging{opacity:.5}
  .thumb .del{
    position:absolute;
    top:6px;
    right:6px;
    width:20px;
    height:20px;
    line-height:20px;
    text-align:center;
    border-radius:999px;
    background:#3a2c2c;
    color:#ffb4b4;
    font-weight:700;
    display:none;
  }
  .thumb:hover .del{display:block}
  .thumb.add{
    align-items:center;
    justify-content:center;
    border:1px dashed var(--border);
    min-height:90px;
  }
  .tile-move{margin-left:auto;display:flex;flex-direction:column;gap:4px;align-items:flex-end;}
  .tile-move button{padding:4px 6px;font-size:12px;}
  .addbox{width:100%;text-align:center}
  .addbox input{
    margin-top:6px;
    width:100%;
    padding:10px;
    border-radius:10px;
    border:1px solid var(--border);
    background:#0e0c22;
    color:var(--text);
    font-size:14px;
  }
  .pill{
    display:inline-flex;
    align-items:center;
    gap:8px;
    padding:6px 10px;
    border-radius:999px;
    background:var(--accent-soft);
    color:var(--text);
    margin-right:6px;
    margin-bottom:6px;
  }
  .pill .x{cursor:pointer;font-weight:700;opacity:.8}
  .mini{font-size:13px}
  .nav{display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin:0 auto 14px auto;padding:0 12px;}
  .nav button{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.08);}
  .nav button.active{background:var(--accent);}
  .section{display:none;}
  .section.active{display:block;}
  .center-card{max-width:980px;margin:0 auto;}
  .wrap{display:flex;flex-direction:column;align-items:center;}
</style>
</head><body>
<div class="wrap">
  <div class="hero">
    <h1>My Lists – Admin</h1>
    <div class="subtitle">Last sync: ${lastSyncText}</div>
  </div>

  <div class="nav">
    <button class="nav-btn active" data-target="snapshot">Snapshot</button>
    <button class="nav-btn" data-target="add">Add Lists</button>
    <button class="nav-btn" data-target="customize">Customize Layout</button>
  </div>

  <section id="section-snapshot" class="section active">
    <div class="card center-card">
      <h3>Current Snapshot</h3>
      <ul>${rows}</ul>
      <div class="rowtools">
        <form method="POST" action="/api/sync?admin=${adminPassword}">
          <button class="btn2" type="submit">🔁 Sync Lists Now</button>
        </form>
        <form method="POST" action="/api/purge-sync?admin=${adminPassword}" onsubmit="return confirm('Purge & re-sync everything?')">
          <button type="submit">🧹 Purge & Sync</button>
        </form>
        <span class="inline-note">Auto-sync every <b>${imdbSyncMinutes}</b> min.</span>
      </div>
      <h4>Manifest URL</h4>
      <p class="code">${manifestUrl}</p>
      <div class="installRow">
        <button type="button" class="btn2" id="installBtn">⭐ Install to Stremio</button>
        <span class="mini muted">If the button doesn’t work, copy the manifest URL into Stremio manually.</span>
      </div>
      <p class="mini muted" style="margin-top:8px;">Manifest version automatically bumps when catalogs, sorting, or ordering change.</p>
    </div>
  </section>

  <section id="section-add" class="section">
    <div class="card center-card">
      <h3>Add & Sources</h3>
      <p class="mini muted" style="margin-top:6px;">We merge your main user (+ extras) and explicit list URLs/IDs. Removing a list also blocks it so it won’t re-appear on the next sync.</p>

      <div class="row">
        <div><label class="mini">Add IMDb/Trakt <b>User</b> URL</label>
          <input id="userInput" placeholder="IMDb user /lists URL or Trakt user" />
        </div>
        <div><button id="addUser" type="button">Add</button></div>
      </div>
      <div class="row">
        <div><label class="mini">Add IMDb/Trakt <b>List</b> URL</label>
          <input id="listInput" placeholder="IMDb ls… or Trakt list URL" />
        </div>
        <div><button id="addList" type="button">Add</button></div>
      </div>

      <div style="margin-top:10px">
        <div class="mini muted">Your IMDb users:</div>
        <div id="userPills"></div>
      </div>
      <div style="margin-top:8px">
        <div class="mini muted">Trakt users to scan:</div>
        <div id="traktUserPills"></div>
      </div>
      <div style="margin-top:8px">
        <div class="mini muted">Your extra lists:</div>
        <div id="listPills"></div>
      </div>
      <div style="margin-top:12px">
        <div class="mini muted">Blocked lists (won't re-add on sync):</div>
        <div id="blockedPills"></div>
      </div>


      <h4 style="margin-top:14px">Discovered</h4>
      <ul>${disc}</ul>
    </div>
  </section>

  <section id="section-customize" class="section">
    <div class="card center-card">
      <h3>Customize (enable, order, sort)</h3>
      <p class="muted">Drag rows to reorder lists or use the arrows. Click ▾ to open the drawer and tune sort options or custom order.</p>
      <div id="prefs"></div>
    </div>
  </section>

</div>

<script>
const ADMIN="${adminPassword}";
const SORT_OPTIONS = ${JSON.stringify(sortOptions)};
const HOST_URL = ${JSON.stringify(baseUrl)};
const SECRET = ${JSON.stringify(sharedSecret)};

async function getPrefs(){ const r = await fetch('/api/prefs?admin='+ADMIN); return r.json(); }
async function getLists(){ const r = await fetch('/api/lists?admin='+ADMIN); return r.json(); }
async function getListItems(lsid){ const r = await fetch('/api/list-items?admin='+ADMIN+'&lsid='+encodeURIComponent(lsid)); return r.json(); }
async function saveCustomOrder(lsid, order){
  const r = await fetch('/api/custom-order?admin='+ADMIN, {method:'POST',headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid, order })});
  if (!r.ok) throw new Error('save failed');
  return r.json();
}

// --- Install Button Logic ---
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('installBtn');
  if (btn) {
    btn.onclick = (e) => {
      e.preventDefault();
      let url = HOST_URL.replace(/^https?:/, 'stremio:') + '/manifest.json';
      if (SECRET) url += '?key=' + SECRET;
      window.location.href = url;
    };
  }

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.section').forEach(sec => {
        sec.classList.toggle('active', sec.id === 'section-' + target);
      });
    });
  });
});

function normalizeUserListsUrl(v){
  v = String(v||'').trim();
  if (!v) return null;
  if (/imdb\\.com\\/user\\/ur\\d+\\/lists/i.test(v)) return { kind:'imdb', value: v };
  const m = v.match(/ur\\d{6,}/i);
  if (m) return { kind:'imdb', value: 'https://www.imdb.com/user/'+m[0]+'/lists/' };

  const trakt = v.match(/trakt\\.tv\\/users\\/([^/]+)/i);
  if (trakt) return { kind:'trakt', value: 'https://trakt.tv/users/' + trakt[1] + '/lists' };
  return { kind:'trakt', value: 'https://trakt.tv/users/' + v + '/lists' };
}
function normalizeListIdOrUrl2(v){
  v = String(v||'').trim();
  if (!v) return null;
  // Trakt lists
  if (/trakt\\.tv\\/users\\/[^/]+\\/lists\\/[^/?#]+/i.test(v)) return v;
  if (/trakt\\.tv\\/lists\\//i.test(v)) return v;
  // IMDb lists
  if (/imdb\\.com\\/(list\\/ls\\d{6,}|chart\\/|search\\/title)/i.test(v)) return v;
  const m = v.match(/ls\\d{6,}/i);
  if (m) return 'https://www.imdb.com/list/'+m[0]+'/';
  if (/imdb\\.com\\/chart\\//i.test(v) || /imdb\\.com\\/search\\/title/i.test(v)) {
    return v.startsWith('http') ? v : 'https://www.imdb.com'+v;
  }
  return null;

}
async function addSources(payload){
  await fetch('/api/add-sources?admin='+ADMIN, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
}
function wireAddButtons(){
  const userBtn = document.getElementById('addUser');
  const listBtn = document.getElementById('addList');
  const userInp = document.getElementById('userInput');
  const listInp = document.getElementById('listInput');
  const traktUserBtn = document.getElementById('addTraktUser');
  const traktUserInp = document.getElementById('traktUserInput');

  userBtn.onclick = async (e) => {
    e.preventDefault();
    const norm = normalizeUserListsUrl(userInp.value);
    if (!norm) { alert('Enter a valid IMDb user /lists URL, ur… id, or Trakt user'); return; }
    userBtn.disabled = true;
    try {
      const payload = { users:[], lists:[], traktUsers:[] };
      if (norm.kind === 'trakt') payload.traktUsers.push(norm.value);
      else payload.users.push(norm.value);
      await addSources(payload);
      location.reload();
    }
    finally { userBtn.disabled = false; }
  };

  listBtn.onclick = async (e) => {
    e.preventDefault();
    const url = normalizeListIdOrUrl2(listInp.value);
    if (!url) { alert('Enter a valid IMDb list URL, ls… id, or Trakt list URL'); return; }
    listBtn.disabled = true;
    try { await addSources({ users:[], lists:[url] }); location.reload(); }
    finally { listBtn.disabled = false; }
  };


}

function el(tag, attrs={}, kids=[]) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === "text") e.textContent = attrs[k];
    else if (k === "html") e.innerHTML = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  kids.forEach(ch => e.appendChild(ch));
  return e;
}
function isCtrl(node){
  const t = (node && node.tagName || "").toLowerCase();
  return t === "input" || t === "select" || t === "button" || t === "a" || t === "label" || t === "textarea";
}

// Row drag (table tbody)
function attachRowDnD(tbody) {
  let dragSrc = null;
  tbody.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr[data-lsid]');
    if (!tr || isCtrl(e.target)) return;
    dragSrc = tr;
    tr.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tr.dataset.lsid || '');
  });
  tbody.addEventListener('dragend', () => {
    if (dragSrc) dragSrc.classList.remove('dragging');
    dragSrc = null;
  });
  tbody.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!dragSrc) return;
    const over = e.target.closest('tr[data-lsid]');
    if (!over || over === dragSrc) return;
    const rect = over.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    over.parentNode.insertBefore(dragSrc, before ? over : over.nextSibling);
  });
}

function moveRowByButtons(tr, dir){
  const tbody = tr.parentNode;
  const rows = Array.from(tbody.querySelectorAll('tr[data-lsid]'));
  const idx = rows.indexOf(tr);
  const nextIdx = Math.min(Math.max(idx + dir, 0), rows.length - 1);
  if (nextIdx === idx) return;
  const ref = rows[nextIdx];
  if (dir < 0) tbody.insertBefore(tr, ref);
  else tbody.insertBefore(tr, ref.nextSibling);
}

// Thumb drag (ul.thumbs)
function attachThumbDnD(ul) {
  let src = null;
  ul.addEventListener('dragstart', (e)=>{
    const li = e.target.closest('li.thumb'); if (!li || li.hasAttribute('data-add')) return;
    src = li; li.classList.add('dragging');
    e.dataTransfer.effectAllowed='move';
    e.dataTransfer.setData('text/plain', li.dataset.id || '');
  });
  ul.addEventListener('dragend', ()=>{ if(src){src.classList.remove('dragging'); src=null;} });
  ul.addEventListener('dragover', (e)=>{
    e.preventDefault();
    if (!src) return;
    const over = e.target.closest('li.thumb'); if (!over || over===src || over.hasAttribute('data-add')) return;
    const rect = over.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height/2;
    over.parentNode.insertBefore(src, before ? over : over.nextSibling);
  });
}

// client-side sort helpers (mirror server)
function toTs(d,y){ if(d){const t=Date.parse(d); if(!Number.isNaN(t)) return t;} if(y){const t=Date.parse(String(y)+'-01-01'); if(!Number.isNaN(t)) return t;} return null; }
function stableSortClient(items, sortKey){
  const s = String(sortKey||'name_asc').toLowerCase();
  const dir = s.endsWith('_asc') ? 1 : -1;
  const key = s.split('_')[0];
  const cmpNullBottom = (a,b) => (a==null && b==null)?0 : (a==null?1 : (b==null?-1 : (a<b?-1:(a>b?1:0))));
  return items.map((m,i)=>({m,i})).sort((A,B)=>{
    const a=A.m,b=B.m; let c=0;
    if (key==='date') c = cmpNullBottom(toTs(a.releaseDate,a.year), toTs(b.releaseDate,b.year));
    else if (key==='rating' || key==='popularity') c = cmpNullBottom(a.imdbRating ?? null, b.imdbRating ?? null);
    else if (key==='runtime') c = cmpNullBottom(a.runtime ?? null, b.runtime ?? null);
    else c = (a.name||'').localeCompare(b.name||'');
    if (c===0){ c=(a.name||'').localeCompare(b.name||''); if(c===0) c=(a.id||'').localeCompare(b.id||''); if(c===0) c=A.i-B.i; }
    return c*dir;
  }).map(x=>x.m);
}

async function render() {
  const prefs = await getPrefs();
  const lists = await getLists();
  prefs.sources = prefs.sources || { users: [], lists: [], traktUsers: [] };

  function renderPills(id, arr, onRemove){
    const wrap = document.getElementById(id); wrap.innerHTML = '';
    (arr||[]).forEach((txt, idx)=>{
      const pill = el('span', {class:'pill'}, [
        el('span',{text:txt}),
        el('span',{class:'x',text:'✕'})
      ]);
      pill.querySelector('.x').onclick = ()=> onRemove(idx);
      wrap.appendChild(pill);
      wrap.appendChild(document.createTextNode(' '));
    });
    if (!arr || !arr.length) wrap.textContent = '(none)';
  }
  renderPills('userPills', prefs.sources?.users || [], (i)=>{
    prefs.sources.users.splice(i,1);
    saveAll('Saved');
  });
  renderPills('traktUserPills', prefs.sources?.traktUsers || [], (i)=>{
    prefs.sources.traktUsers.splice(i,1);
    saveAll('Saved');
  });
  (function renderUserPills(){
    const wrap = document.getElementById('userPills'); wrap.innerHTML = '';
    const entries = [];
    (prefs.sources?.users || []).forEach((u,i)=>entries.push({ kind:'imdb', value:u, idx:i }));
    (prefs.sources?.traktUsers || []).forEach((u,i)=>entries.push({ kind:'trakt', value:u, idx:i }));
    if (!entries.length) { wrap.textContent = '(none)'; return; }
    entries.forEach(entry=>{
      const pill = el('span', {class:'pill'}, [
        el('span',{text:(entry.kind==='imdb'?'IMDb: ':'Trakt: ')+entry.value}),
        el('span',{class:'x',text:'✕'})
      ]);
      pill.querySelector('.x').onclick = ()=>{
        const arr = entry.kind==='imdb' ? prefs.sources.users : prefs.sources.traktUsers;
        arr.splice(entry.idx,1);
        saveAll('Saved');
      };
      wrap.appendChild(pill);
      wrap.appendChild(document.createTextNode(' '));
    });
  })();
  renderPills('listPills', prefs.sources?.lists || [], (i)=>{ prefs.sources.lists.splice(i,1); saveAll('Saved'); });
  renderPills('blockedPills', prefs.blocked || [], (i)=>{ prefs.blocked.splice(i,1); saveAll('Saved'); });

  const container = document.getElementById('prefs');
  container.innerHTML = '';

  const table = el('table');
  const thead = el('thead');
  thead.appendChild(el('tr',{},[
    el('th',{text:''}),
    el('th',{text:'Enabled?'}),
    el('th',{text:'Move'}),
    el('th',{text:'List'}),
    el('th',{text:'Count'}),
    el('th',{text:'Sort'}),
    el('th',{text:'Remove'})
  ]));
  table.appendChild(thead);

  const tbody = el('tbody');

  const enabledSet = new Set(prefs.enabled || []);
  const perSort = prefs.perListSort || {};
  const perOpts = prefs.sortOptions || {};
  const order = (prefs.order || Object.keys(lists || {})).filter(id => !!lists[id]);

  const cloneItems = (arr) => (arr || []).map(x=> ({...x}));
  const stableSort = (arr, fn) => arr.map((m,i)=>({m,i})).sort((A,B)=>{const c=fn(A.m,B.m); return c===0 ? A.i-B.i : c; }).map(x=>x.m);
  const alpha = arr => stableSort(arr, (a,b)=> (a.name||'').localeCompare(b.name||''));
  const uniq = arr => Array.from(new Set(arr.filter(Boolean)));

  // order helper (imdb/date_asc/date_desc) backed by LISTS[lsid].orders
  const orderFor = (sortKey, lsid) => {
    const list = lists[lsid];
    if (!list || !list.orders) return null;
    if (sortKey === 'imdb' && list.orders.imdb) return cloneItems(list.orders.imdb);
    if (sortKey === 'date_asc' && list.orders.date_asc) return cloneItems(list.orders.date_asc);
    if (sortKey === 'date_desc' && list.orders.date_desc) return cloneItems(list.orders.date_desc);
    return null;
  };

  function attachSortOptions(lsid, drawer){
    const optsWrap = drawer.querySelector('.sortopts');
    const sel = drawer.querySelector('select');
    const tip = drawer.querySelector('.inline-note');

    const opts = uniq([ 'custom', ...(lists[lsid]?.sortOptions || []), ...(prefs.sortOptions?.[lsid] || []), 'name_asc', 'name_desc' ]);
    const def = 'name_asc';
    const clientOnly = ['popularity_asc','popularity_desc'];
    const known = new Set(['custom','imdb','date_asc','date_desc','rating_asc','rating_desc','runtime_asc','runtime_desc','name_asc','name_desc','popularity_desc','popularity_asc']);
    opts.forEach(o => {
      const opt = el('option', { value:o, text:o });
      if (o === (prefs.perListSort?.[lsid] || def)) opt.setAttribute('selected','');
      sel.appendChild(opt);
    });
    if (opts.length < 2) tip.textContent = 'Sort options will appear after sync (IMDb lists only).';
    sel.onchange = () => {
      prefs.perListSort = prefs.perListSort || {};
      prefs.perListSort[lsid] = sel.value;
      const isCustom = sel.value === 'custom';
      const isClient = clientOnly.includes(sel.value);
      optsWrap.style.display = isCustom ? 'block' : 'none';
      tip.textContent = isClient ? 'Client-side sort (local) so it does not affect Stremio order.' : '';
    };
    sel.onchange();
  }

  function attachPrefs(tbody){
    function addRow(lsid){
      if (tbody.querySelector('tr[data-lsid="'+lsid+'"]')) return;
      const row = makeRow(lsid);
      const idx = order.indexOf(lsid);
      const rows = Array.from(tbody.querySelectorAll('tr[data-lsid]'));
      if (idx < 0 || idx >= rows.length) tbody.appendChild(row);
      else tbody.insertBefore(row, rows[idx]);
    }
    function removeRow(lsid){
      tbody.querySelectorAll('tr[data-lsid="'+lsid+'"]').forEach(el=> el.remove());
    }

    const seen = new Set(Object.keys(lists));
    const blocked = new Set(prefs.blocked || []);
    for (const id of order) addRow(id);
    for (const id of Object.keys(lists)) {
      if (!seen.has(id) && !blocked.has(id)) addRow(id);
    }
    prefs.blocked.forEach(removeRow);

    function addBlockRow(lsid, url){
      const tr = el('tr',{'data-lsid':lsid});
      tr.appendChild(el('td',{}));
      const cb = el('input',{type:'checkbox'}); cb.checked = false; cb.disabled = true;
      tr.appendChild(el('td',{},[cb]));
      const empty = el('td',{}); tr.appendChild(empty);
      const name = el('td',{}); name.appendChild(el('div',{text:lsid})); name.appendChild(el('small',{text:url})); tr.appendChild(name);
      tr.appendChild(el('td',{}));
      tr.appendChild(el('td',{}));
      const addBack = el('button',{text:'Unblock',type:'button'});
      addBack.onclick = ()=>{
        const i = prefs.blocked.indexOf(lsid);
        if (i >= 0) prefs.blocked.splice(i,1);
        addRow(lsid);
        tr.remove();
      };
      tr.appendChild(el('td',{},[addBack]));
      tbody.appendChild(tr);
    }
    if (blocked.size) {
      tbody.appendChild(el('tr',{},[
        el('td',{text:'',style:'border-bottom:0'}),
        el('td',{text:'',style:'border-bottom:0'}),
        el('td',{text:'',style:'border-bottom:0'}),
        el('td',{text:'Blocked',style:'border-bottom:0;font-weight:700'}),
        el('td',{text:'',style:'border-bottom:0'}),
        el('td',{text:'',style:'border-bottom:0'}),
        el('td',{text:'',style:'border-bottom:0'})
      ]));
      prefs.blocked.forEach(lsid => addBlockRow(lsid, lists?.[lsid]?.url || 'manual'));
    }
  }

  // per-list data (custom sort + per-sort client-side order helper)
  function makeDrawer(lsid){
    const drawer = el('tr', {'data-drawer-for': lsid, class:'drawer'}, [
      el('td',{html:'&nbsp;'}),
      el('td',{html:'&nbsp;'}),
      el('td',{html:'&nbsp;'}),
      el('td',{colspan:'4'})
    ]);

    const wrap = el('div');
    const note = el('span',{class:'inline-note muted',text:'(Saved to Stremio / manifest → bumps manifest version)'});
    wrap.appendChild(note);
    wrap.appendChild(el('div',{text:'Choose: custom order, IMDb raw order, or sort by date/rating/runtime/name'}));

    const opts = el('div',{class:'sortopts'});

    const sel = el('select');
    opts.appendChild(sel);

    const tip = el('div',{class:'inline-note'});
    opts.appendChild(tip);

    attachSortOptions(lsid, { querySelector:(s)=>({'.sortopts':opts, 'select':sel, '.inline-note':tip}[s]) });
    opts.style.display = (prefs.perListSort?.[lsid] === 'custom') ? 'block' : 'none';

    wrap.appendChild(el('div',{},[opts]));

    const resetBtn = el('button',{text:'Reset current view'});
    const resetAllBtn = el('button',{text:'Full reset'});
    const saveBtn = el('button',{text:'Save order'});
    saveBtn.style.marginLeft = '8px';
    resetBtn.style.marginLeft = '0';
    resetAllBtn.style.marginLeft = '8px';

    const btnWrap = el('div',{style:'display:flex;gap:8px;margin:8px 0;flex-wrap:wrap'});
    btnWrap.appendChild(resetBtn);
    btnWrap.appendChild(resetAllBtn);
    btnWrap.appendChild(saveBtn);
    wrap.appendChild(btnWrap);

    const ul = el('ul',{class:'thumbs'});
    wrap.appendChild(ul);

    drawer.querySelector('td[colspan]').appendChild(wrap);

    let items = [];

    function renderList(listItems){
      ul.innerHTML = '';
      listItems.forEach((item,i)=>{
        const li = el('li',{class:'thumb',draggable:'true','data-id':item.id});
        if (item.poster) li.appendChild(el('img',{class:'thumb-img',src:item.poster,alt:''}));
        li.appendChild(el('div',{},[
          el('div',{class:'title',text:item.name||''}),
          el('div',{class:'id',text:item.id||''})
        ]));
        const mv = el('div',{class:'tile-move'});
        const up = el('button',{text:'↑'}); const down = el('button',{text:'↓'});
        up.onclick = ()=>{ moveByButtons(li,-1); };
        down.onclick = ()=>{ moveByButtons(li,1); };
        mv.appendChild(up); mv.appendChild(down);
        li.appendChild(mv);
        const del = el('span',{class:'del',text:'✕'}); del.onclick = ()=>{ li.remove(); };
        li.appendChild(del);
        ul.appendChild(li);
      });

      const addLi = el('li',{class:'thumb add', 'data-add':'1'});
      addLi.appendChild(el('div',{class:'addbox'}, [
        el('div',{text:'Add IMDb id (tt…) or URL'}),
        el('input',{placeholder:'tt… or https://www.imdb.com/title/tt…'})
      ]));
      const input = addLi.querySelector('input');
      input.onkeydown = (e)=>{
        if (e.key === 'Enter') {
          const val = normalizeImdbIdOrUrl(input.value);
          if (val) {
            ul.insertBefore(elFromId(val), addLi);
            input.value = '';
          } else alert('Enter a valid IMDb title id or URL');
        }
      };
      ul.appendChild(addLi);

      attachThumbDnD(ul);
    }

    function normalizeImdbIdOrUrl(v){
      const m = String(v||'').match(/tt\d{7,}/);
      if (m) return 'tt' + m[0].slice(2);
      return null;
    }

    function elFromId(tt){
      return el('li',{class:'thumb',draggable:'true','data-id':tt},[
        el('div',{class:'title',text:tt}),
        el('div',{class:'id',text:tt})
      ]);
    }

    function moveByButtons(li, dir){
      const lis = Array.from(ul.querySelectorAll('li.thumb'));
      const idx = lis.indexOf(li);
      const nextIdx = Math.min(Math.max(idx + dir, 0), lis.length - 2);
      if (nextIdx === idx) return;
      const ref = lis[nextIdx];
      if (dir < 0) ul.insertBefore(li, ref);
      else ul.insertBefore(li, ref.nextSibling);
    }

    const perSortChanges = () => {
      prefs.perListSort = prefs.perListSort || {};
      prefs.perListSort[lsid] = 'custom';
      drawer.querySelector('.sortopts').style.display = 'block';
    };

    function renderAddons(){
      const addBtn = el('button',{text:'Add to top', type:'button'});
      const addBtn2 = el('button',{text:'Add to bottom', type:'button'});
      addBtn.onclick = ()=>{
        const addBox = ul.querySelector('[data-add] input');
        const val = normalizeImdbIdOrUrl(addBox.value);
        if (!val) { alert('Enter a valid IMDb id (tt…) or URL'); return; }
        ul.insertBefore(elFromId(val), ul.querySelector('[data-add]'));
        addBox.value = '';
        perSortChanges();
      };
      addBtn2.onclick = ()=>{
        const addBox = ul.querySelector('[data-add] input');
        const val = normalizeImdbIdOrUrl(addBox.value);
        if (!val) { alert('Enter a valid IMDb id (tt…) or URL'); return; }
        ul.insertBefore(elFromId(val), ul.querySelector('[data-add]').nextSibling);
        addBox.value = '';
        perSortChanges();
      };
      const row = el('div',{style:'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px'});
      row.appendChild(addBtn);
      row.appendChild(addBtn2);
      row.appendChild(el('span',{class:'inline-note',text:'Add custom IMDb ids to this list (applied client-side).'}));
      drawer.querySelector('td[colspan]').insertBefore(row, drawer.querySelector('.sortopts'));
    }

    renderAddons();

    fetch('/api/list-items?admin='+ADMIN+'&lsid='+encodeURIComponent(lsid))
    .then(r=>r.json()).then(({ items, imdbDateAsc=[], imdbDateDesc=[] })=>{
      items = items || [];
      items = items.filter(it=>!!(it && it.id));

      const curSort = perSort[lsid] || 'name_asc';
      const sortKey = curSort === 'custom' ? (perSort[lsid]||'name_asc') : curSort;
      const initialOrder = (()=>{
        if (sortKey === 'custom') {
          const ids = (perOpts[lsid] || []);
          const map = new Map(ids.map((tt,i)=>[tt,i]));
          return items.slice().sort((a,b)=> (map.get(a.id)||1e9) - (map.get(b.id)||1e9));
        } else if (sortKey === 'imdb' && lists[lsid].orders?.imdb) {
          const pos = new Map(lists[lsid].orders.imdb.map((id,i)=>[id,i]));
          return items.slice().sort((a,b)=> (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
        } else if (sortKey === 'date_asc' && imdbDateAsc.length){
          const pos = new Map(imdbDateAsc.map((id,i)=>[id,i]));
          return items.slice().sort((a,b)=> (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
        } else if (sortKey === 'date_desc' && imdbDateDesc.length){
          const pos = new Map(imdbDateDesc.map((id,i)=>[id,i]));
          return items.slice().sort((a,b)=> (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
        } else {
          return stableSortClient(items, sortKey);
        }
      })();

      renderList(initialOrder);

      saveBtn.onclick = async ()=>{
        const ids = Array.from(ul.querySelectorAll('li.thumb[data-id]')).map(li=>li.getAttribute('data-id'));
        saveBtn.disabled = true; resetBtn.disabled = true; resetAllBtn.disabled = true;
        try {
          await saveCustomOrder(lsid, ids);
          const rowSel = document.querySelector('tr[data-lsid="'+lsid+'"] select');
          if (rowSel) rowSel.value = 'custom';
          prefs.perListSort = prefs.perListSort || {}; prefs.perListSort[lsid] = 'custom';
          saveBtn.textContent = "Saved ✓";
          setTimeout(()=> saveBtn.textContent = "Save order", 1500);
        } catch(e) {
          alert("Failed to save custom order");
        } finally {
          saveBtn.disabled = false; resetBtn.disabled = false; resetAllBtn.disabled = false;
        }
      };

      resetBtn.onclick = ()=>{
        const rowSel = document.querySelector('tr[data-lsid="'+lsid+'"] select');
        const chosen = rowSel ? rowSel.value : (prefs.perListSort?.[lsid] || 'name_asc');
        renderList(orderFor(chosen));
      };

      resetAllBtn.onclick = async ()=>{
        if (!confirm('Full reset: clear custom order and local add/remove edits for this list?')) return;
        resetAllBtn.disabled = true;
        try{
          await fetch('/api/list-reset?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid })});
          await refresh();
        } finally {
          resetAllBtn.disabled = false;
        }
      };

      async function refresh(){
        const r = await getListItems(lsid);
        items = r.items || [];
        const rowSel = document.querySelector('tr[data-lsid="'+lsid+'"] select');
        const chosen = rowSel ? rowSel.value : (prefs.perListSort?.[lsid] || 'name_asc');
        renderList(orderFor(chosen));
      }
    }).catch(()=>{ td.textContent = "Failed to load items."; });

    return tr;
  }

  function removeList(lsid){
    if (!confirm('Remove this list and block it from reappearing?')) return;
    fetch('/api/remove-list?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ lsid })})
      .then(()=> location.reload())
      .catch(()=> alert('Remove failed'));
  }

  function makeRow(lsid) {
    const L = lists[lsid];
    const tr = el('tr', {'data-lsid': lsid, draggable:'true'});

    const chev = el('span',{class:'chev',text:'▾', title:'Open custom order & sort options'});
    const chevTd = el('td',{},[chev]);

    const cb = el('input', {type:'checkbox'}); cb.checked = enabledSet.has(lsid);
    cb.addEventListener('change', ()=>{ if (cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); });

    const moveWrap = el('div',{class:'move-btns'});
    const upBtn = el('button',{type:'button',text:'↑'});
    const downBtn = el('button',{type:'button',text:'↓'});
    moveWrap.appendChild(upBtn); moveWrap.appendChild(downBtn);
    upBtn.onclick = (e)=>{ e.preventDefault(); moveRowByButtons(tr,-1); };
    downBtn.onclick = (e)=>{ e.preventDefault(); moveRowByButtons(tr,1); };
    const moveTd = el('td',{},[moveWrap]);

    const nameCell = el('td',{});
    nameCell.appendChild(el('div',{text:(L.name||lsid)}));
    nameCell.appendChild(el('small',{text:lsid}));

    const count = el('td',{text:String((L.ids||[]).length)});

    const sortSel = el('select');
    SORT_OPTIONS.forEach(o=>{
      const opt = el('option',{value:o,text:o});
      const def = (prefs.perListSort && prefs.perListSort[lsid]) || "name_asc";
      if (o===def) opt.setAttribute('selected','');
      sortSel.appendChild(opt);
    });
    sortSel.addEventListener('change', ()=>{
      prefs.perListSort = prefs.perListSort || {};
      prefs.perListSort[lsid] = sortSel.value;
      const drawer = document.querySelector('tr[data-drawer-for="'+lsid+'"]');
      if (drawer && drawer.style.display !== "none") {
        const resetBtn = drawer.querySelectorAll('button')[1];
        if (resetBtn) resetBtn.click();
      }
    });

    const rmBtn = el('button',{text:'Remove', type:'button'});
    rmBtn.onclick = ()=> removeList(lsid);

    tr.appendChild(chevTd);
    tr.appendChild(el('td',{},[cb]));
    tr.appendChild(moveTd);
    tr.appendChild(nameCell);
    tr.appendChild(count);
    tr.appendChild(el('td',{},[sortSel]));
    tr.appendChild(el('td',{},[rmBtn]));

    let drawer = null; let open = false;
    chev.onclick = ()=>{
      open = !open;
      if (open) {
        chev.textContent = "▴";
        if (!drawer) {
          drawer = makeDrawer(lsid);
          tr.parentNode.insertBefore(drawer, tr.nextSibling);
        } else {
          drawer.style.display = "";
        }
      } else {
        chev.textContent = "▾";
        if (drawer) drawer.style.display = "none";
      }
    };

    return tr;
  }

  order.forEach(lsid => tbody.appendChild(makeRow(lsid)));
  table.appendChild(tbody);
  attachRowDnD(tbody);

  container.appendChild(table);

  const saveWrap = el('div',{style:'margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap'});
  const saveBtn = el('button',{text:'Save', type:'button'});
  const msg = el('span',{class:'inline-note'});
  saveWrap.appendChild(saveBtn); saveWrap.appendChild(msg);
  container.appendChild(saveWrap);

  async function saveAll(text){
    const newOrder = Array.from(tbody.querySelectorAll('tr[data-lsid]')).map(tr => tr.getAttribute('data-lsid'));
    const enabled = Array.from(enabledSet);
    const body = {
      enabled,
      order: newOrder,
      defaultList: prefs.defaultList || (enabled[0] || ""),
      perListSort: prefs.perListSort || {},
      sortOptions: prefs.sortOptions || {},
      upgradeEpisodes: prefs.upgradeEpisodes || false,
      sources: prefs.sources || {},
      blocked: prefs.blocked || []
    };
    msg.textContent = "Saving…";
    const r = await fetch('/api/prefs?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    const t = await r.text();
    msg.textContent = text || t || "Saved.";
    setTimeout(()=>{ msg.textContent = ""; }, 1800);
  }

  saveBtn.onclick = ()=> saveAll();
}

wireAddButtons();
render();
</script>
</body></html>`;
}

module.exports = { renderAdminPage };
