(async function(){
  const qs = new URLSearchParams(location.search);
  const ADMIN = qs.get("admin") || "";
  if (!ADMIN) { document.body.innerHTML = "<div class='wrap'><div class='card'>Append <b>?admin=YOUR_PASSWORD</b> to the URL.</div></div>"; return; }

  async function j(url, body){
    const r = await fetch(url + (url.includes("?")?"&":"?") + "admin=" + encodeURIComponent(ADMIN), body ? {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(body)
    } : undefined);
    if (!r.ok) throw new Error(await r.text());
    const ct = r.headers.get("content-type")||"";
    return ct.includes("application/json") ? r.json() : r.text();
  }

  const constants = await j("/api/constants").catch(()=>({version:"?", syncEveryMinutes:0, sortOptions:[]}));
  const prefs = await j("/api/prefs");
  const lists = await j("/api/lists");

  document.getElementById("lastSync").textContent = `Auto-sync every ${constants.syncEveryMinutes} min • v${constants.version}`;

  const app = document.getElementById("app");
  const card = (html)=>{ const d=document.createElement("div"); d.className="card"; d.innerHTML=html; return d; };

  // Snapshot card
  const listHtml = Object.keys(lists).map(id => {
    const L = lists[id]; const count=(L.ids||[]).length;
    return `<li><b>${L.name||id}</b> <span class="small">(${count} items)</span><br/><span class="small">${L.url||""}</span></li>`;
  }).join("") || "<li>(none)</li>";
  app.appendChild(card(`<h3>Current Snapshot</h3><ul>${listHtml}</ul>
    <form method="POST" action="/api/sync?admin=${encodeURIComponent(ADMIN)}"><button>Sync IMDb Lists Now</button></form>
    <span class="small">Manifest URL: <code>${location.origin}/manifest.json</code></span>`));

  // Preferences table (very trimmed)
  const enabledSet = new Set(prefs.enabled && prefs.enabled.length ? prefs.enabled : Object.keys(lists));
  const baseOrder = (prefs.order && prefs.order.length ? prefs.order.filter(id => lists[id]) : []);
  const missing   = Object.keys(lists).filter(id => !baseOrder.includes(id))
    .sort((a,b)=>( (lists[a]?.name||a).localeCompare(lists[b]?.name||b) ));
  const order = baseOrder.concat(missing);

  const tbl = document.createElement("table");
  tbl.innerHTML = `<thead><tr><th>Enabled</th><th>List</th><th>Items</th><th>Default sort</th></tr></thead><tbody></tbody>`;
  const tbody = tbl.querySelector("tbody");
  order.forEach(lsid => {
    const L = lists[lsid];
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><input type="checkbox" ${enabledSet.has(lsid)?"checked":""}></td>
      <td><b>${L.name||lsid}</b><div class="small">${lsid}</div></td>
      <td>${(L.ids||[]).length}</td>
      <td><select></select></td>`;
    const cb = tr.querySelector("input"); cb.onchange = ()=>{ if(cb.checked) enabledSet.add(lsid); else enabledSet.delete(lsid); };
    const sel = tr.querySelector("select");
    const def = (prefs.perListSort && prefs.perListSort[lsid]) || "imdb";
    constants.sortOptions.forEach(o=>{
      const opt = document.createElement("option"); opt.value=o; opt.textContent=o; if(o===def) opt.selected=true; sel.appendChild(opt);
    });
    sel.onchange = ()=>{ prefs.perListSort = prefs.perListSort || {}; prefs.perListSort[lsid] = sel.value; };
    tbody.appendChild(tr);
  });
  const prefsCard = card(`<h3>Customize</h3>`);
  prefsCard.appendChild(tbl);
  const saveBtn = document.createElement("button"); saveBtn.textContent = "Save";
  const note = document.createElement("span"); note.className="small"; note.style.marginLeft="8px";
  saveBtn.onclick = async ()=>{
    const body = {
      enabled: Array.from(enabledSet),
      order: order,
      defaultList: prefs.defaultList || (Array.from(enabledSet)[0] || ""),
      perListSort: prefs.perListSort || {},
      sortOptions: prefs.sortOptions || {},
      upgradeEpisodes: prefs.upgradeEpisodes || false,
      sources: prefs.sources || {},
      blocked: prefs.blocked || []
    };
    note.textContent = "Saving…";
    await j("/api/prefs", body);
    note.textContent = "Saved.";
    setTimeout(()=> note.textContent = "", 1200);
  };
  prefsCard.appendChild(saveBtn);
  prefsCard.appendChild(note);
  app.appendChild(prefsCard);
})();
