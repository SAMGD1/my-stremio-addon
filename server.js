// server.js – My Lists (modular)
// v12.2.2
import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  state,
  isImdb, isListId, manifestKey, maybeBackgroundSync, scheduleNextSync,
  catalogs, cardFor, applyCustomOrder, stableSort, fullSync,
  getListItemsFor, loadSnapshot, saveSnapshot, adminAllowed, addonAllowed,
  CINEMETA, SORT_OPTIONS
} from "./lib/state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT  = Number(process.env.PORT || 7000);
const HOST  = "0.0.0.0";

const app = express();
app.use((_, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });
app.use(express.json({ limit: "1mb" }));
app.use("/public", express.static(path.join(__dirname, "public")));

app.get("/health", (_,res)=>res.status(200).send("ok"));

// Small helper to build absolute base
function absoluteBase(req){
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

// Admin UI (static file)
app.get("/admin", (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden. Append ?admin=YOUR_PASSWORD");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Constants for client
app.get("/api/constants", (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  res.json({
    version: "12.2.2",
    syncEveryMinutes: state.IMDB_SYNC_MINUTES,
    sortOptions: SORT_OPTIONS
  });
});

// ------- Snapshot/debug helpers -------
app.get("/api/lists", (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  res.json(state.LISTS);
});
app.get("/api/prefs", (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  res.json(state.PREFS);
});
app.post("/api/prefs", async (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const body = req.body || {};
    const PREFS = state.PREFS;

    PREFS.enabled         = Array.isArray(body.enabled) ? body.enabled.filter(isListId) : [];
    PREFS.order           = Array.isArray(body.order)   ? body.order.filter(isListId)   : [];
    PREFS.defaultList     = isListId(body.defaultList) ? body.defaultList : "";
    PREFS.perListSort     = body.perListSort && typeof body.perListSort === "object" ? body.perListSort : (PREFS.perListSort || {});
    PREFS.sortOptions     = body.sortOptions && typeof body.sortOptions === "object" ? Object.fromEntries(Object.entries(body.sortOptions).map(([k,v])=>[k, (Array.isArray(v)?v:[]).filter(x=>SORT_OPTIONS.includes(x))])) : (PREFS.sortOptions || {});
    PREFS.upgradeEpisodes = !!body.upgradeEpisodes;

    if (body.customOrder && typeof body.customOrder === "object") {
      PREFS.customOrder = body.customOrder;
    }

    // sources
    const src = body.sources || {};
    PREFS.sources = {
      users: Array.isArray(src.users) ? src.users.map(s=>String(s).trim()).filter(Boolean) : (PREFS.sources.users || []),
      lists: Array.isArray(src.lists) ? src.lists.map(s=>String(s).trim()).filter(Boolean) : (PREFS.sources.lists || [])
    };

    // blocked
    PREFS.blocked = Array.isArray(body.blocked) ? body.blocked.filter(isListId) : (PREFS.blocked || []);

    const key = manifestKey();
    if (key !== state.LAST_MANIFEST_KEY) { state.LAST_MANIFEST_KEY = key; state.MANIFEST_REV++; }

    await saveSnapshot();

    res.status(200).send("Saved. Manifest rev " + state.MANIFEST_REV);
  }catch(e){ console.error("prefs save error:", e); res.status(500).send("Failed to save"); }
});

// unblock a previously removed list
app.post("/api/unblock-list", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid||"");
    if (!/^ls\d{6,}$/i.test(lsid)) return res.status(400).send("Invalid lsid");
    state.PREFS.blocked = (state.PREFS.blocked || []).filter(id => id !== lsid);
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send("Unblocked & synced");
  }catch(e){ console.error(e); res.status(500).send("Failed"); }
});

// return cards for one list (for the drawer)
app.get("/api/list-items", (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  const lsid = String(req.query.lsid || "");
  const items = getListItemsFor(lsid).map(tt => state.CARD.get(tt) || cardFor(tt));
  res.json({ items });
});

// save a per-list custom order and set default sort=custom
app.post("/api/custom-order", async (req,res) => {
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid || "");
    const order = Array.isArray(req.body.order) ? req.body.order.filter(isImdb) : [];
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    const list = state.LISTS[lsid];
    if (!list) return res.status(404).send("List not found");

    const set = new Set(list.ids);
    const clean = order.filter(id => set.has(id)); // keep only items that exist in list

    state.PREFS.customOrder = state.PREFS.customOrder || {};
    state.PREFS.customOrder[lsid] = clean;
    state.PREFS.perListSort = state.PREFS.perListSort || {};
    state.PREFS.perListSort[lsid] = "custom";

    const key = manifestKey();
    if (key !== state.LAST_MANIFEST_KEY) { state.LAST_MANIFEST_KEY = key; state.MANIFEST_REV++; }

    await saveSnapshot();
    res.status(200).json({ ok:true, manifestRev: state.MANIFEST_REV });
  }catch(e){ console.error("custom-order:", e); res.status(500).send("Failed"); }
});

// add items locally to a list
app.post("/api/list-add-items", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid || "");
    const items = Array.isArray(req.body.items) ? req.body.items.map(String).filter(isImdb) : [];
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    if (!state.LISTS[lsid]) return res.status(404).send("List not found");
    state.PREFS.extras = state.PREFS.extras || {};
    const prev = new Set(state.PREFS.extras[lsid] || []);
    items.forEach(tt => prev.add(tt));
    state.PREFS.extras[lsid] = Array.from(prev);
    // reflect in current LISTS (end)
    const set = new Set(state.LISTS[lsid].ids);
    for (const tt of items) if (!set.has(tt)) state.LISTS[lsid].ids.push(tt);
    // preload simple cards
    for (const tt of items) { state.CARD.set(tt, cardFor(tt)); }
    await saveSnapshot();
    res.status(200).send("Added");
  } catch(e){ console.error(e); res.status(500).send("Failed"); }
});

// remove/hide items locally
app.post("/api/list-remove-items", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid || "");
    const items = Array.isArray(req.body.items) ? req.body.items.map(String).filter(isImdb) : [];
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    if (!state.LISTS[lsid]) return res.status(404).send("List not found");
    state.PREFS.removed = state.PREFS.removed || {};
    const prev = new Set(state.PREFS.removed[lsid] || []);
    items.forEach(tt => prev.add(tt));
    state.PREFS.removed[lsid] = Array.from(prev);
    // reflect in current LISTS
    state.LISTS[lsid].ids = (state.LISTS[lsid].ids || []).filter(tt => !prev.has(tt));
    await saveSnapshot();
    res.status(200).send("Removed");
  } catch(e){ console.error(e); res.status(500).send("Failed"); }
});

// reset all local changes for a list
app.post("/api/list-reset-local", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid || "");
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    if (state.PREFS.extras)  delete state.PREFS.extras[lsid];
    if (state.PREFS.removed) delete state.PREFS.removed[lsid];
    if (state.PREFS.customOrder) delete state.PREFS.customOrder[lsid];
    state.PREFS.perListSort = state.PREFS.perListSort || {};
    state.PREFS.perListSort[lsid] = "imdb";
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send("Local changes cleared & synced");
  } catch(e){ console.error(e); res.status(500).send("Failed"); }
});

// add sources quickly then sync
app.post("/api/add-sources", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const users = Array.isArray(req.body.users) ? req.body.users.map(s=>String(s).trim()).filter(Boolean) : [];
    const lists = Array.isArray(req.body.lists) ? req.body.lists.map(s=>String(s).trim()).filter(Boolean) : [];
    state.PREFS.sources = state.PREFS.sources || { users:[], lists:[] };
    state.PREFS.sources.users = Array.from(new Set([ ...(state.PREFS.sources.users||[]), ...users ]));
    state.PREFS.sources.lists = Array.from(new Set([ ...(state.PREFS.sources.lists||[]), ...lists ]));
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send("Sources added & synced");
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});

// remove/block a list
app.post("/api/remove-list", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    const lsid = String(req.body.lsid||"");
    if (!isListId(lsid)) return res.status(400).send("Invalid lsid");
    delete state.LISTS[lsid];
    state.PREFS.enabled = (state.PREFS.enabled||[]).filter(id => id!==lsid);
    state.PREFS.order   = (state.PREFS.order||[]).filter(id => id!==lsid);
    state.PREFS.blocked = Array.from(new Set([ ...(state.PREFS.blocked||[]), lsid ]));

    state.LAST_MANIFEST_KEY = ""; state.MANIFEST_REV++; // force bump
    await saveSnapshot();
    res.status(200).send("Removed & blocked");
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});

app.post("/api/sync", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send(`Synced at ${new Date().toISOString()}. <a href="/admin?admin=${process.env.ADMIN_PASSWORD||"Stremio_172"}">Back</a>`);
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});
app.post("/api/purge-sync", async (req,res)=>{
  if (!adminAllowed(req)) return res.status(403).send("Forbidden");
  try{
    state.LISTS = Object.create(null);
    state.BEST.clear(); state.FALLBK.clear(); state.EP2SER.clear(); state.CARD.clear();
    state.PREFS.customOrder = state.PREFS.customOrder || {};
    await fullSync({ rediscover:true });
    scheduleNextSync();
    res.status(200).send(`Purged & synced at ${new Date().toISOString()}. <a href="/admin?admin=${process.env.ADMIN_PASSWORD||"Stremio_172"}">Back</a>`);
  }catch(e){ console.error(e); res.status(500).send(String(e)); }
});

// ------- Manifest & catalog/meta -------
app.get("/manifest.json", (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();
    const baseManifest = {
      id: "org.mylists.snapshot",
      version: `12.2.2-${state.MANIFEST_REV}`,
      name: "My Lists",
      description: "Your IMDb lists as catalogs (cached).",
      resources: ["catalog","meta"],
      types: ["My lists","movie","series"],
      idPrefixes: ["tt"],
      catalogs: catalogs()
    };
    res.json(baseManifest);
  }catch(e){ console.error("manifest:", e); res.status(500).send("Internal Server Error");}
});

function parseExtra(extraStr, qObj){
  const p = new URLSearchParams(extraStr||"");
  return { ...Object.fromEntries(p.entries()), ...(qObj||{}) };
}
app.get("/catalog/:type/:id/:extra?.json", (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const { id } = req.params;
    if (!id || !id.startsWith("list:")) return res.json({ metas: [] });
    const lsid = id.slice(5);
    const list = state.LISTS[lsid];
    if (!list) return res.json({ metas: [] });

    const extra = parseExtra(req.params.extra, req.query);
    const q = String(extra.search||"").toLowerCase().trim();
    const sortReq = String(extra.sort||"").toLowerCase();
    const defaultSort = (state.PREFS.perListSort && state.PREFS.perListSort[lsid]) || "imdb";
    const sort = sortReq || defaultSort;
    const skip = Math.max(0, Number(extra.skip||0));
    const limit = Math.min(Number(extra.limit||100), 200);

    let metas = (list.ids||[]).map(tt => state.CARD.get(tt) || cardFor(tt));

    if (q) {
      metas = metas.filter(m =>
        (m.name||"").toLowerCase().includes(q) ||
        (m.id||"").toLowerCase().includes(q) ||
        (m.description||"").toLowerCase().includes(q)
      );
    }

    if (sort === "custom") metas = applyCustomOrder(metas, lsid);
    else if (sort === "imdb") metas = metas.slice();
    else metas = stableSort(metas, sort);

    res.json({ metas: metas.slice(skip, skip+limit) });
  }catch(e){ console.error("catalog:", e); res.status(500).send("Internal Server Error"); }
});

app.get("/meta/:type/:id.json", async (req,res)=>{
  try{
    if (!addonAllowed(req)) return res.status(403).send("Forbidden");
    maybeBackgroundSync();

    const imdbId = req.params.id;
    if (!isImdb(imdbId)) return res.json({ meta:{ id: imdbId, type:"movie", name:"Unknown item" } });

    const rec = state.BEST.get(imdbId);
    const fb = state.FALLBK.get(imdbId) || {};
    if (!rec || !rec.meta) {
      return res.json({ meta: { id: imdbId, type: rec?.kind || fb.type || "movie", name: fb.name || imdbId, poster: fb.poster || undefined } });
    }
    res.json({ meta: { ...rec.meta, id: imdbId, type: rec.kind } });
  }catch(e){ console.error("meta:", e); res.status(500).send("Internal Server Error"); }
});

// ----------------- BOOT -----------------
(async () => {
  try {
    await loadSnapshot();
  } catch(e){ console.warn("[BOOT] load snapshot failed:", e.message); }

  fullSync({ rediscover: true }).then(()=> scheduleNextSync()).catch(e => {
    console.warn("[BOOT] background sync failed:", e.message);
  });

  app.listen(PORT, HOST, () => {
    console.log(`Admin:    http://localhost:${PORT}/admin?admin=${process.env.ADMIN_PASSWORD||"Stremio_172"}`);
    console.log(`Manifest: http://localhost:${PORT}/manifest.json${process.env.SHARED_SECRET ? `?key=${process.env.SHARED_SECRET}` : ""}`);
  });
})();
