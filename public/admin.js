// public/admin.js
(() => {
  const ADMIN = window.__ADMIN || '';
  if (!ADMIN) {
    document.body.innerHTML = '<p style="padding:16px">Missing <code>?admin=YOUR_PASSWORD</code> in the URL.</p>';
    return;
  }

  const SORT_OPTIONS = ["custom","imdb","date_asc","date_desc","rating_asc","rating_desc","runtime_asc","runtime_desc","name_asc","name_desc"];

  const $ = sel => document.querySelector(sel);
  const el = (tag, attrs = {}, kids = []) => {
    const e = document.createElement(tag);
    for (const k in attrs) {
      if (k === "text") e.textContent = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) e.appendChild(kid);
    return e;
  };
  const isCtrl = n => {
    const t = (n && n.tagName || "").toLowerCase();
    return t === "input" || t === "select" || t === "button" || t === "a" || t === "textarea" || t === "label";
  };

  function sortClient(arr, sortKey){
    const s = String(sortKey||'imdb').toLowerCase();
    if (s === 'imdb') return arr.slice();
    if (s === 'custom') return arr.slice();
    const dir = s.endsWith('_asc') ? 1 : -1;
    const key = s.split('_')[0];
    const cmpNull = (a,b)=> (a==null && b==null)?0 : (a==null?1:(b==null?-1:(a<b?-1:(a>b?1:0))));
    const toTs=(d,y)=>{ if(d){const t=Date.parse(d); if(!Number.isNaN(t)) return t;} if(y){const t=Date.parse(String(y)+'-01-01'); if(!Number.isNaN(t)) return t;} return null; };
    return arr.map((m,i)=>({m,i})).sort((A,B)=>{
      const a=A.m,b=B.m; let c=0;
      if (key==='date') c = cmpNull(toTs(a.releaseDate,a.year), toTs(b.releaseDate,b.year));
      else if (key==='rating') c = cmpNull(a.imdbRating ?? null, b.imdbRating ?? null);
      else if (key==='runtime') c = cmpNull(a.runtime ?? null, b.runtime ?? null);
      else c = (a.name||'').localeCompare(b.name||'');
      if (c===0){ c=(a.name||'').localeCompare(b.name||''); if(c===0) c=(a.id||'').localeCompare(b.id||''); if(c===0) c=A.i-B.i; }
      return c*dir;
    }).map(x=>x.m);
  }

  async function jget(url){
    const r = await fetch(url);
    if (!r.ok) throw new Error('GET failed: '+url);
    return r.json();
  }
  async function jpost(url, body){
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('POST failed: '+url);
    try { return await r.json(); } catch { return {}; }
  }

  async function getPrefs(){ return jget('/api/prefs?admin='+ADMIN); }
  async function getLists(){ return jget('/api/lists?admin='+ADMIN); }
  async function getListItems(lsid){ return jget('/api/list-items?admin='+ADMIN+'&lsid='+encodeURIComponent(lsid)); }
  async function savePrefs(body){ return fetch('/api/prefs?admin='+ADMIN, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)}); }
  async function saveCustomOrder(lsid, order){ return jpost('/api/custom-order?admin='+ADMIN, { lsid, order }); }

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
    tbody.addEventListener('dragend', () => { if (dragSrc) dragSrc.classList.remove('dragging'); dragSrc = null; });
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

  // Thumb drag (ul.thumbs)
  function attachThumbDnD(ul) {
    let src = null;
    ul.addEventListener('dragstart', (e)=>{
      const li = e.target.closest('li.thumb'); if (!li) return;
      if (li.classList.contains('add')) return;
      src = li; li.classList.add('dragging');
      e.dataTransfer.effectAllowed='move';
      e.dataTransfer.setData('text/plain', li.dataset.id || '');
    });
    ul.addEventListener('dragend', ()=>{ if(src){src.classList.remove('dragging'); src=null;} });
    ul.addEventListener('dragover', (e)=>{
      e.preventDefault();
      if (!src) return;
      const over = e.target.closest('li.thumb'); if (!over || over===src || over.classList.contains('add')) return;
      const rect = over.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height/2;
      over.parentNode.insertBefore(src, before ? over : over.nextSibling);
    });
  }

  async function render() {
    const prefs = await getPrefs();
    const lists = await getLists();

    // Sources pills
    function renderPills(id, arr, onRemove){
      const wrap = document.getElementById(id); if (!wrap) return;
      wrap.innerHTML = '';
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
    // Unblock pills
    {
      const wrap = document.getElementById('blockedPills');
      if (wrap) {
        wrap.innerHTML = '';
        const blocked = prefs.blocked || [];
        if (!blocked.length) wrap.textContent = '(none)';
        blocked.forEach(lsid=>{
          const pill = el('span',{class:'pill'},[
            el('span',{text:lsid}),
            el('span',{class:'x',text:' Unblock'})
          ]);
          pill.querySelector('.x').onclick = async ()=>{
            await jpost('/api/unblock-list?admin='+ADMIN, { lsid });
            location.reload();
          };
          wrap.appendChild(pill);
          wrap.appendChild(document.createTextNode(' '));
        });
      }
    }
    renderPills('userPills', prefs.sources?.users || [], (i)=>{
      prefs.sources.users.splice(i,1);
      saveAll('Saved');
    });
    renderPills('listPills', prefs.sources?.lists || [], (i)=>{
      prefs.sources.lists.splice(i,1);
      saveAll('Saved');
    });

    const addUserBtn = document.getElementById('addUser');
    if (addUserBtn) addUserBtn.onclick = async (e)=>{
      e.preventDefault();
      const v = (document.getElementById('userInput')?.value || '').trim();
      if (!v) return;
      prefs.sources = prefs.sources || {users:[],lists:[]};
      if (!prefs.sources.users.includes(v)) prefs.sources.users.push(v);
      document.getElementById('userInput').value = '';
      await saveAll('Added user');
    };
    const addListBtn = document.getElementById('addList');
    if (addListBtn) addListBtn.onclick = async (e)=>{
      e.preventDefault();
      const v = (document.getElementById('listInput')?.value || '').trim();
      if (!v) return;
      prefs.sources = prefs.sources || {users:[],lists:[]};
      if (!prefs.sources.lists.includes(v)) prefs.sources.lists.push(v);
      document.getElementById('listInput').value = '';
      await saveAll('Added list');
    };

    // ----- table -----
    const container = document.getElementById('prefs'); if (!container) return;
    container.innerHTML = "";

    const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));
    const baseOrder = (prefs.order && prefs.order.length ? prefs.order.filter(id => lists[id]) : []);
    const missing   = Object.keys(lists).filter(id => !baseOrder.includes(id))
      .sort((a,b)=>( (lists[a]?.name||a).localeCompare(lists[b]?.name||b) ));
    const order = baseOrder.concat(missing);

    const table = el('table');
    const thead = el('thead', {}, [el('tr',{},[
      el('th',{text:''}), el('th',{text:'Enabled'}), el('th',{text:'List (lsid)'}), el('th',{text:'Items'}),
      el('th',{text:'Default sort'}), el('th',{text:'Remove'})
    ])]);
    table.appendChild(thead);
    const tbody = el('tbody');

    function removeList(lsid){
      if (!confirm('Remove this list and block it from reappearing?')) return;
      fetch('/api/remove-list?admin='+ADMIN, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ lsid })
      }).then(()=> location.reload()).catch(()=> alert('Remove failed'));
    }

    function makeDrawer(lsid, sortSel) {
      const tr = el('tr',{class:'drawer', 'data-drawer-for':lsid});
      const td = el('td',{colspan:'6'});
      td.appendChild(el('div',{text:'Loading…'}));
      tr.appendChild(td);

      const makeLi = (it)=>{
        const li = el('li',{class:'thumb','data-id':it.id,draggable:'true'});
        li.appendChild(el('img',{src: it.poster || '', alt:''}));
        const wrap = el('div',{},[
          el('div',{class:'title',text: it.name || it.id}),
          el('div',{class:'id',text: it.id})
        ]);
        li.appendChild(wrap);
        const del = el('div',{class:'del',text:'×',title:'Remove'});
        del.onclick = (e)=>{ e.stopPropagation(); li.remove(); };
        li.appendChild(del);
        return li;
      };

      getListItems(lsid).then(({items})=>{
        td.innerHTML = '';

        const tools = el('div', {class:'rowtools'});
        const saveBtn    = el('button',{text:'Save order'});
        const resetBtn   = el('button',{text:'Reset order (to current sort)'});
        const restoreBtn = el('button',{text:'Restore from IMDb'});
        tools.appendChild(saveBtn); tools.appendChild(resetBtn); tools.appendChild(restoreBtn);

        const optsWrap = el('div',{class:'rowtools'});
        optsWrap.appendChild(el('span',{class:'mini muted', text:'Sort options shown in Stremio:'}));
        const current = (prefs.sortOptions && prefs.sortOptions[lsid] && prefs.sortOptions[lsid].length) ? new Set(prefs.sortOptions[lsid]) : new Set(SORT_OPTIONS);
        SORT_OPTIONS.forEach(opt=>{
          const lab = el('label',{class:'pill'});
          const cb = el('input',{type:'checkbox'}); cb.checked = current.has(opt);
          cb.onchange = ()=>{
            const arr = Array.from(optsWrap.querySelectorAll('input')).map((c,i)=>c.checked?SORT_OPTIONS[i]:null).filter(Boolean);
            prefs.sortOptions = prefs.sortOptions || {};
            prefs.sortOptions[lsid] = arr.length ? arr : SORT_OPTIONS.slice();
          };
          lab.appendChild(cb);
          lab.appendChild(el('span',{text:opt}));
          optsWrap.appendChild(lab);
        });

        td.appendChild(tools);
        td.appendChild(optsWrap);

        const ul = el('ul',{class:'thumbs', id:'ul-'+lsid});

        // initial render using custom order or per-list default
        const co = (prefs.customOrder && prefs.customOrder[lsid]) || [];
        let working = items.slice();
        if (co && co.length) {
          const pos = new Map(co.map((id,i)=>[id,i]));
          working.sort((a,b)=>{
            const pa = pos.has(a.id) ? pos.get(a.id) : 1e9;
            const pb = pos.has(b.id) ? pos.get(b.id) : 1e9;
            return pa - pb;
          });
        } else {
          const def = (prefs.perListSort && prefs.perListSort[lsid]) || 'imdb';
          working = (def==='imdb') ? items.slice() : sortClient(items, def);
        }

        function renderUl(arr){
          ul.innerHTML = '';
          arr.forEach(it => ul.appendChild(makeLi(it)));
          const addLi = el('li',{class:'thumb add',draggable:'false'});
          const box = el('div',{},[ el('div',{class:'title',text:'Add item (tt...)'}) ]);
          addLi.appendChild(box);
          addLi.onclick = ()=>{
            const t = prompt('Enter IMDb tconst (ttXXXXXXXX):');
            if (!t) return;
            const tt = String(t).trim();
            if (!/^tt\d{7,}$/i.test(tt)) { alert('Invalid tconst'); return; }
            ul.insertBefore(makeLi({id:tt,name:tt,poster:''}), addLi);
          };
          ul.appendChild(addLi);
        }

        renderUl(working);
        td.appendChild(ul);
        attachThumbDnD(ul);

        // live sort preview
        sortSel.onchange = ()=>{
          prefs.perListSort = prefs.perListSort || {};
          prefs.perListSort[lsid] = sortSel.value;
          const mode = sortSel.value || 'imdb';
          const idsNow = Array.from(ul.querySelectorAll('li.thumb'))
            .filter(li => !li.classList.contains('add'))
            .map(li => li.dataset.id);
          const map = new Map(items.map(x => [x.id, x]));
          const domCards = idsNow.map(id => map.get(id) || { id, name:id, poster:'' });
          const reordered = (mode==='imdb') ? domCards : sortClient(domCards, mode);
          renderUl(reordered);
          attachThumbDnD(ul);
        };

        // save → add/remove + custom order
        saveBtn.onclick = async ()=>{
          const ids = Array.from(ul.querySelectorAll('li.thumb'))
            .filter(li => !li.classList.contains('add'))
            .map(li => li.getAttribute('data-id'));

          const origSet = new Set(items.map(x => x.id));
          const nowSet  = new Set(ids);
          const adds    = ids.filter(id => !origSet.has(id));
          const removes = Array.from(origSet).filter(id => !nowSet.has(id));

          saveBtn.disabled = true; resetBtn.disabled = true; restoreBtn.disabled = true;
          try {
            if (adds.length)    await jpost('/api/list-add-items?admin='+ADMIN,    { lsid, items: adds });
            if (removes.length) await jpost('/api/list-remove-items?admin='+ADMIN, { lsid, items: removes });

            await saveCustomOrder(lsid, ids); // flips default sort → custom on server

            sortSel.value = 'custom';
            prefs.perListSort = prefs.perListSort || {};
            prefs.perListSort[lsid] = 'custom';

            items.length = 0;
            ids.forEach(id => items.push({ id, name:id, poster:'' }));

            saveBtn.textContent = 'Saved ✓';
            setTimeout(()=> saveBtn.textContent = 'Save order', 1200);
          } catch (e) {
            console.error(e);
            alert('Save failed');
          } finally {
            saveBtn.disabled = false; resetBtn.disabled = false; restoreBtn.disabled = false;
          }
        };

        // reset visual order to current sort
        resetBtn.onclick = ()=>{
          const mode = (sortSel.value || 'imdb').toLowerCase();
          const domIds = Array.from(ul.querySelectorAll('li.thumb'))
            .filter(li => !li.classList.contains('add'))
            .map(li => li.dataset.id);
          const map = new Map(items.map(x => [x.id, x]));
          const domCards = domIds.map(id => map.get(id) || { id, name:id, poster:'' });
          const reordered =
            (mode === 'imdb') ? domCards :
            (mode === 'custom') ? domCards :
            sortClient(domCards, mode);
          renderUl(reordered);
          attachThumbDnD(ul);
        };

        // restore from IMDb
        restoreBtn.onclick = async ()=>{
          if (!confirm('This will remove local additions, un-hide removed items, and clear custom order for this list. Continue?')) return;
          restoreBtn.disabled = true;
          try{
            await jpost('/api/list-reset-local?admin='+ADMIN, { lsid });
            sortSel.value = 'imdb';
            prefs.perListSort = prefs.perListSort || {};
            prefs.perListSort[lsid] = 'imdb';
            location.reload();
          }catch(e){
            console.error(e);
            alert('Failed to restore');
          }finally{
            restoreBtn.disabled = false;
          }
        };
      }).catch(()=>{ td.textContent = "Failed to load items."; });
      return tr;
    }

    function makeRow(lsid) {
      const L = lists[lsid];
      const tr = el('tr', {'data-lsid': lsid, draggable:'true'});

      const chev = el('span',{class:'chev',text:'▾', title:'Open items & sort options'});
      const chevTd = el('td',{},[chev]);

      const cb = el('input', {type:'checkbox'}); cb.checked = enabledSet.has(lsid);
      cb.addEventListener('change', ()=>{ if (cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); });

      const nameCell = el('td',{}); 
      nameCell.appendChild(el('div',{text:(L.name||lsid)}));
      nameCell.appendChild(el('small',{text:lsid}));

      const count = el('td',{text:String((L.ids||[]).length)});

      const sortSel = el('select');
      const def = (prefs.perListSort && prefs.perListSort[lsid]) || 'imdb';
      SORT_OPTIONS.forEach(o=>{
        const opt = el('option',{value:o,text:o});
        if (o===def) opt.setAttribute('selected','');
        sortSel.appendChild(opt);
      });
      sortSel.addEventListener('change', ()=>{ prefs.perListSort = prefs.perListSort || {}; prefs.perListSort[lsid] = sortSel.value; });

      const rmBtn = el('button',{text:'Remove'});
      rmBtn.onclick = ()=> removeList(lsid);

      tr.appendChild(chevTd);
      tr.appendChild(el('td',{},[cb]));
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
            drawer = makeDrawer(lsid, sortSel);
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
    const saveBtn = el('button',{text:'Save'});
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
      const r = await savePrefs(body);
      const t = await r.text();
      msg.textContent = text || t || "Saved.";
      setTimeout(()=>{ msg.textContent = ""; }, 1800);
    }

    saveBtn.onclick = ()=> saveAll();
  }

  render().catch(err=>{
    console.error(err);
    alert('Failed to load admin UI.');
  });
})();
