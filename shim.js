/* Brain – prepojenie aplikácie na Supabase.
   Nahrádza rozhranie window.claude z Claude artefaktu (db, assets, downloads),
   aby kód aplikácie ostal rovnaký. Dáta: tabuľka public.docs (kolekcia, id, JSON),
   fotky: privátny bucket "assets". Lokálna kópia v IndexedDB → appka funguje aj offline. */
(() => {
"use strict";
const CFG = window.BRAIN_CONFIG || {};
const CONFIGURED = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(CFG.url || "") && String(CFG.key || "").length > 20 && !/VLOZ|XXXX/i.test(CFG.key);
const URL0 = String(CFG.url || "").replace(/\/$/, "");
const VERSION = "1.0.0";

/* ---------- IndexedDB (lokálna kópia) ---------- */
const IDB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open("brain", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const t = db.transaction("kv", mode); const req = fn(t.objectStore("kv"));
    t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
  }));
  return {
    get: k => tx("readonly", s => s.get(k)).catch(() => undefined),
    set: (k, v) => tx("readwrite", s => s.put(v, k)).catch(() => {}),
    clear: () => tx("readwrite", s => s.clear()).catch(() => {})
  };
})();

/* ---------- Stav ---------- */
let sb = null, session = null, uid = "", email = "";
const cache = new Map();      // kolekcia -> Map(id -> data)
const fetched = new Set();
const loading = new Map();
const subs = new Map();       // kolekcia -> Set(poslucháč)
let queue = [];               // neodoslané zmeny {k, op, coll, id, data}
const waiters = new Map();
let lastSync = null, syncErr = "";

const clone = v => v == null ? v : (typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
const genId = () => { const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; const b = crypto.getRandomValues(new Uint8Array(20)); return Array.from(b, x => a[x % a.length]).join(""); };
const hex32 = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, "0")).join("");
const isNetErr = e => !navigator.onLine || e instanceof TypeError || /fetch|network|load failed|timed? ?out/i.test(String(e && (e.message || e.details) || ""));
const collMap = c => { let m = cache.get(c); if (!m) { m = new Map(); cache.set(c, m); } return m; };

/* ---------- Snapshoty (rovnaký tvar ako v Claude) ---------- */
function cmp(a, b) {
  if (a === b) return 0; if (a == null) return 1; if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}
function matchW(d, [f, op, v]) {
  const x = d[f];
  switch (op) {
    case "==": case "eq": return x === v;
    case "!=": case "ne": return x !== v;
    case "<": case "lt": return cmp(x, v) < 0;
    case "<=": case "lte": return cmp(x, v) <= 0;
    case ">": case "gt": return x != null && cmp(x, v) > 0;
    case ">=": case "gte": return x != null && cmp(x, v) >= 0;
    case "in": return Array.isArray(v) && v.includes(x);
    case "not-in": return Array.isArray(v) && !v.includes(x);
    case "array-contains": return Array.isArray(x) && x.includes(v);
    default: return true;
  }
}
const docSnap = (id, data) => ({ id, exists: data !== undefined, data: () => data === undefined ? undefined : clone(data) });
function querySnap(coll, q) {
  const m = cache.get(coll) || new Map();
  let arr = [...m].map(([id, data]) => ({ id, data }));
  for (const w of q.w || []) arr = arr.filter(x => matchW(x.data || {}, w));
  if (q.f) { arr = arr.filter(x => x.data && x.data[q.f] !== undefined); arr.sort((a, b) => cmp(a.data[q.f], b.data[q.f]) * (q.dir === "desc" ? -1 : 1)); }
  if (q.n) arr = arr.slice(0, q.n);
  const docs = arr.map(x => docSnap(x.id, x.data));
  return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) };
}

/* ---------- Poslucháči ---------- */
const pendingNotify = new Set();
function notify(coll) {
  if (pendingNotify.has(coll)) return; pendingNotify.add(coll);
  queueMicrotask(() => { pendingNotify.delete(coll); for (const l of subs.get(coll) || []) deliver(l); });
}
function deliver(l) {
  if (!cache.has(l.coll)) return;
  try { l.next(l.docId != null ? docSnap(l.docId, (cache.get(l.coll) || new Map()).get(l.docId)) : querySnap(l.coll, l.q)); }
  catch (e) { console.error(e); }
}
function addSub(l) {
  let s = subs.get(l.coll); if (!s) { s = new Set(); subs.set(l.coll, s); } s.add(l);
  if (cache.has(l.coll)) queueMicrotask(() => deliver(l));
  load(l.coll).catch(err => { if (!cache.has(l.coll) && l.err) l.err({ code: "unavailable", message: String(err && err.message || err) }); });
  return () => s.delete(l);
}

/* ---------- Načítanie kolekcie: najprv lokálne, potom zo servera ---------- */
const persistT = new Map();
function persist(coll) {
  clearTimeout(persistT.get(coll));
  persistT.set(coll, setTimeout(() => IDB.set(`c:${uid}:${coll}`, [...(cache.get(coll) || new Map())]), 400));
}
async function fetchColl(coll) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("docs").select("id,data").eq("coll", coll).order("id").range(from, from + 999);
    if (error) throw error;
    out.push(...data); if (data.length < 1000) break;
  }
  return out;
}
function load(coll, force) {
  if (!force && fetched.has(coll)) return Promise.resolve();
  if (loading.has(coll)) return loading.get(coll);
  const p = (async () => {
    if (!cache.has(coll)) {
      const local = await IDB.get(`c:${uid}:${coll}`);
      if (local && !cache.has(coll)) { cache.set(coll, new Map(local)); notify(coll); }
    }
    try {
      const rows = await fetchColl(coll);
      const m = new Map(rows.map(r => [r.id, r.data]));
      cache.set(coll, m);
      for (const op of queue) if (op.coll === coll) applyLocal(op);
      fetched.add(coll); lastSync = new Date(); syncErr = "";
      notify(coll); persist(coll);
    } catch (e) {
      syncErr = isNetErr(e) ? "offline" : String(e.message || e);
      if (!cache.has(coll)) { if (isNetErr(e)) { cache.set(coll, new Map()); notify(coll); } else throw e; }
    }
  })().finally(() => loading.delete(coll));
  loading.set(coll, p); return p;
}

/* ---------- Zápisy: hneď lokálne, potom na server (fronta prežije offline) ---------- */
function applyLocal(op) {
  const m = collMap(op.coll);
  if (op.op === "set") m.set(op.id, clone(op.data));
  else if (op.op === "merge") m.set(op.id, { ...(m.get(op.id) || {}), ...clone(op.data) });
  else if (op.op === "del") m.delete(op.id);
}
const saveQueue = () => IDB.set(`q:${uid}`, queue.map(({ k, op, coll, id, data }) => ({ k, op, coll, id, data })));
function settle(k, ok, err) { const w = waiters.get(k); if (!w) return; waiters.delete(k); ok ? w.res() : w.rej(err); }
function write(op) {
  op.k = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  if (op.data !== undefined) op.data = clone(op.data);
  applyLocal(op); notify(op.coll); persist(op.coll);
  queue.push(op); saveQueue();
  const p = new Promise((res, rej) => waiters.set(op.k, { res, rej }));
  flush(); return p;
}
async function execOp(op) {
  let r;
  if (op.op === "set") r = await sb.from("docs").upsert({ owner: uid, coll: op.coll, id: op.id, data: op.data }, { onConflict: "owner,coll,id" });
  else if (op.op === "merge") r = await sb.rpc("doc_merge", { p_coll: op.coll, p_id: op.id, p_data: op.data });
  else r = await sb.from("docs").delete().eq("owner", uid).eq("coll", op.coll).eq("id", op.id);
  if (r && r.error) throw r.error;
}
let flushing = false;
async function flush() {
  if (flushing || !sb || !uid) return; flushing = true;
  try {
    while (queue.length) {
      const op = queue[0];
      try { await execOp(op); queue.shift(); saveQueue(); settle(op.k, true); lastSync = new Date(); syncErr = ""; }
      catch (e) {
        if (isNetErr(e)) { syncErr = "offline"; for (const o of queue) settle(o.k, true); break; }
        queue.shift(); saveQueue(); settle(op.k, false, { code: "write_failed", message: String(e.message || e) });
        syncErr = String(e.message || e); load(op.coll, true);
      }
    }
  } finally { flushing = false; refreshAccount(); }
}

/* ---------- Referencie (API ako v Claude) ---------- */
function D(coll, id) {
  return {
    id, path: coll + "/" + id,
    set: (data, opts) => write({ op: opts && opts.merge ? "merge" : "set", coll, id, data: data || {} }),
    update: data => write({ op: "merge", coll, id, data: data || {} }),
    delete: () => write({ op: "del", coll, id }),
    get: () => load(coll).then(() => docSnap(id, (cache.get(coll) || new Map()).get(id))),
    onSnapshot: (next, err) => addSub({ coll, docId: id, next, err })
  };
}
function Q(coll, q) {
  return {
    orderBy: (f, dir) => Q(coll, { ...q, f, dir: dir === "desc" ? "desc" : "asc" }),
    limit: n => Q(coll, { ...q, n }),
    where: (f, op, v) => Q(coll, { ...q, w: [...(q.w || []), [f, op, v]] }),
    doc: id => D(coll, id || genId()),
    add: data => { const d = D(coll, genId()); return d.set(data).then(() => d); },
    get: () => load(coll).then(() => querySnap(coll, q)),
    onSnapshot: (next, err) => addSub({ coll, docId: null, q, next, err })
  };
}
const dbApi = {
  collection: path => Q(String(path), {}),
  doc: path => { const s = String(path); const i = s.lastIndexOf("/"); return D(s.slice(0, i), s.slice(i + 1)); }
};

/* ---------- Fotky a prílohy ---------- */
async function shrink(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type || "")) return file;
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    if (s === 1 && file.size < 900000) return file;
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const b = await new Promise(r => c.toBlob(r, "image/jpeg", 0.82));
    return b || file;
  } catch (e) { return file; }
}
const blobUrl = id => new URL("_blob/" + id, document.baseURI).href;
const assetsApi = {
  upload: async (file, opts) => {
    const body = await shrink(file);
    const type = body.type || (opts && opts.type) || file.type || "application/octet-stream";
    const id = hex32();
    const { error } = await sb.storage.from("assets").upload(uid + "/" + id, body, { contentType: type, upsert: false, cacheControl: "31536000" });
    if (error) throw { code: /size|large|exceed/i.test(error.message || "") ? "too_large" : "upload_failed", message: error.message };
    try { const c = await caches.open("brain-blobs"); await c.put(blobUrl(id), new Response(body, { headers: { "Content-Type": type } })); } catch (e) {}
    return { id, contentType: type, sizeBytes: body.size };
  }
};

/* ---------- Sťahovanie súborov ---------- */
const MIME = { json: "application/json", csv: "text/csv", txt: "text/plain", md: "text/markdown", html: "text/html", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml" };
const dlApi = {
  save: async ({ filename, data }) => {
    const ext = String(filename || "").split(".").pop().toLowerCase();
    const blob = data instanceof Blob ? data : new Blob([data], { type: MIME[ext] || "application/octet-stream" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename || "subor";
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
    return { status: "saved" };
  }
};

/* ---------- Service worker (offline + zobrazovanie fotiek) ---------- */
function postSW() {
  if (!("serviceWorker" in navigator) || !session) return;
  const msg = { type: "auth", url: URL0, key: CFG.key, uid, token: session.access_token };
  navigator.serviceWorker.ready.then(r => r.active && r.active.postMessage(msg)).catch(() => {});
  if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage(msg);
}
if ("serviceWorker" in navigator && location.protocol === "https:") {
  /* Automatická aktualizácia: pri návrate do appky skontroluje novú verziu; nová verzia → appka sa obnoví
     (ak práve píšeš, počká, kým appku zavrieš alebo prepneš). */
  const hadCtrl = !!navigator.serviceWorker.controller; let pendingReload = false;
  const typing = () => { const a = document.activeElement; return !!(a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable)) || !!document.querySelector("#formPanel,#cdPanel,.drawer"); };
  const doReload = () => { if (typing()) { pendingReload = true; return; } location.reload(); };
  navigator.serviceWorker.register("sw.js").then(reg => {
    const check = () => reg.update().catch(() => {});
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { if (pendingReload && !typing()) location.reload(); else check(); }
    });
    window.addEventListener("focus", check);
    setInterval(check, 15 * 60 * 1000);
  }).catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadCtrl) doReload(); });
  navigator.serviceWorker.addEventListener("message", async e => {
    if (e.data && e.data.type === "need-auth" && sb) { const { data } = await sb.auth.getSession(); if (data && data.session) { session = data.session; postSW(); } }
  });
}

/* ---------- Obrazovky: nastavenie, prihlásenie, prázdna databáza ---------- */
const CSS = `
.bz-ov{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:radial-gradient(900px 500px at 50% 0%,rgba(47,123,255,.22),transparent 60%),var(--bg,#04070c);color:var(--fg,#e6edf7);font:15px/1.5 var(--f-body,system-ui)}
.bz-card{width:min(380px,100%);display:flex;flex-direction:column;gap:14px;text-align:center}
.bz-logo{width:72px;height:82px;margin:0 auto 4px;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);background:linear-gradient(160deg,#8fd0ff,#2f7bff 45%,#0b2c7a);display:grid;place-items:center}
.bz-logo i{width:38px;height:44px;clip-path:inherit;background:var(--bg,#04070c)}
.bz-card h1{font-family:var(--f-display,system-ui);font-size:30px;margin:0}
.bz-card p{margin:0;color:var(--muted,#90a3bc);font-size:14px}
.bz-card form{display:flex;flex-direction:column;gap:10px;text-align:left}
.bz-card label{font-size:12px;font-weight:600;color:var(--muted,#90a3bc);display:flex;flex-direction:column;gap:5px}
.bz-card input{background:var(--surface,#0a1019);border:1px solid var(--line-2,#25395a);color:inherit;border-radius:10px;padding:11px 12px;font:inherit}
.bz-btn{border:0;border-radius:10px;padding:12px 14px;font:inherit;font-weight:700;cursor:pointer;background:linear-gradient(135deg,#2f7bff,#0b2c7a);color:#fff}
.bz-btn.ghost{background:none;border:1px solid var(--line-2,#25395a);color:inherit;font-weight:600}
.bz-err{color:var(--crit,#f2675c);font-size:13px;min-height:1.2em}
.bz-card label.bz-btn{display:block;color:#fff;font-size:15px;font-weight:700;text-align:center;cursor:pointer}
`;
function overlay(html) {
  if (!document.getElementById("bz-css")) { const s = document.createElement("style"); s.id = "bz-css"; s.textContent = CSS; document.head.appendChild(s); }
  const el = document.createElement("div"); el.className = "bz-ov"; el.innerHTML = `<div class="bz-card"><div class="bz-logo"><i></i></div>${html}</div>`;
  document.body.appendChild(el); return el;
}
function showSetup() {
  overlay(`<h1>Brain</h1><p>Aplikácia ešte nie je napojená na databázu. V súbore <b>config.js</b> chýba adresa a kľúč projektu Supabase.</p>`);
}
function showLogin() {
  return new Promise(resolve => {
    const el = overlay(`<h1>Brain</h1><p>Prihlás sa svojím účtom.</p>
      <form id="bzLogin" autocomplete="on"><label>E-mail<input type="email" name="email" autocomplete="username" required></label>
      <label>Heslo<input type="password" name="password" autocomplete="current-password" required></label>
      <div class="bz-err" id="bzErr"></div><button class="bz-btn" type="submit">Prihlásiť sa</button></form>`);
    const f = el.querySelector("#bzLogin"), err = el.querySelector("#bzErr");
    f.onsubmit = async e => {
      e.preventDefault(); err.textContent = ""; const b = f.querySelector("button"); b.disabled = true; b.textContent = "Prihlasujem…";
      const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
      b.disabled = false; b.textContent = "Prihlásiť sa";
      if (error || !data.session) { err.textContent = error && /invalid/i.test(error.message) ? "Nesprávny e-mail alebo heslo." : isNetErr(error) ? "Nie si online. Skús to znova." : "Prihlásenie zlyhalo: " + (error && error.message || ""); return; }
      el.remove(); resolve(data.session);
    };
  });
}
async function checkEmpty() {
  try {
    const { count, error } = await sb.from("docs").select("id", { count: "exact", head: true });
    if (error || count !== 0) return;
    const el = overlay(`<h1>Vitaj v Brain</h1><p>Tvoja databáza je zatiaľ prázdna. Ak máš zálohu z pôvodnej aplikácie (súbor <b>brain-zaloha….json</b>), nahraj ju sem.</p>
      <label class="bz-btn" style="display:block">Nahrať zálohu<input type="file" accept=".json,application/json" hidden id="bzImp"></label>
      <button class="bz-btn ghost" type="button" id="bzSkip">Začať s prázdnym</button><div class="bz-err" id="bzErr2"></div>`);
    el.querySelector("#bzSkip").onclick = () => el.remove();
    el.querySelector("#bzImp").onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      const out = el.querySelector("#bzErr2"); out.style.color = "var(--muted)"; out.textContent = "Nahrávam…";
      try { const n = await importBackup(file, t => out.textContent = t); out.textContent = `Hotovo: ${n} záznamov.`; setTimeout(() => el.remove(), 900); }
      catch (x) { out.style.color = ""; out.textContent = "Zálohu sa nepodarilo nahrať: " + (x.message || x); }
    };
  } catch (e) {}
}

/* ---------- Úplná záloha a obnova ---------- */
async function exportAll() {
  const cols = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("docs").select("coll,id,data").order("coll").order("id").range(from, from + 999);
    if (error) throw error;
    for (const r of data) (cols[r.coll] = cols[r.coll] || {})[r.id] = r.data;
    if (data.length < 1000) break;
  }
  return { app: "brain", version: 1, exported: new Date().toISOString(), collections: cols };
}
async function importBackup(file, progress) {
  const j = JSON.parse(await file.text());
  let cols = j && j.collections;
  if (!cols && Array.isArray(j && j.items)) cols = { items: Object.fromEntries(j.items.filter(x => x && x.id).map(({ id, ...x }) => [String(id), x])) };
  if (!cols || typeof cols !== "object") throw new Error("neznámy formát súboru");
  const rows = [];
  for (const [coll, docs] of Object.entries(cols)) for (const [id, data] of Object.entries(docs || {})) if (data && typeof data === "object") rows.push({ owner: uid, coll, id, data });
  for (let i = 0; i < rows.length; i += 400) {
    const { error } = await sb.from("docs").upsert(rows.slice(i, i + 400), { onConflict: "owner,coll,id" });
    if (error) throw error;
    progress && progress(`Nahrávam… ${Math.min(i + 400, rows.length)} / ${rows.length}`);
  }
  for (const c of [...fetched]) load(c, true);
  return rows.length;
}

/* ---------- Sekcia Účet (zobrazuje ju aplikácia) ---------- */
let accEl = null;
function refreshAccount() { if (accEl && accEl.isConnected) { accEl.innerHTML = accountInner(); bindAccount(accEl); } }
function accountInner() {
  const st = !navigator.onLine || syncErr === "offline" ? "offline – zmeny sa uložia a odošlú neskôr" : syncErr ? "chyba: " + syncErr : "online";
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<section class="panel"><div class="panel-h"><h2>Prihlásenie a synchronizácia</h2></div><div class="panel-b" style="display:flex;flex-direction:column;gap:8px">
    <div>Prihlásený: <b>${esc(email || "–")}</b></div><div>Stav: <b>${esc(st)}</b></div>
    <div>Neodoslané zmeny: <b>${queue.length}</b>${lastSync ? ` · posledná synchronizácia ${lastSync.toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" })}` : ""}</div>
    <div class="actions"><button class="btn sm" type="button" id="bzSync">Synchronizovať teraz</button><button class="btn sm danger" type="button" id="bzOut">Odhlásiť sa</button></div></div></section>
  <section class="panel"><div class="panel-h"><h2>Záloha</h2></div><div class="panel-b" style="display:flex;flex-direction:column;gap:8px">
    <p style="margin:0;color:var(--muted)">Celá databáza (všetky sekcie) v jednom súbore JSON. Fotky ostávajú v úložisku.</p>
    <div class="actions"><button class="btn sm primary" type="button" id="bzExp">Stiahnuť celú zálohu</button><label class="btn sm">Obnoviť zo zálohy<input type="file" id="bzImpA" accept=".json,application/json" hidden></label></div>
    <div id="bzAccMsg" style="font-size:13px;color:var(--muted)"></div></div></section>
  <section class="panel"><div class="panel-h"><h2>Inštalácia do zariadenia</h2></div><div class="panel-b"><ul style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px">
    <li><b>iPhone / iPad:</b> otvor túto stránku v Safari → tlačidlo Zdieľať → <i>Pridať na plochu</i>. Potom Brain spúšťaj z ikony.</li>
    <li><b>Mac:</b> Safari → menu Súbor → <i>Pridať do Docku</i> (macOS Sonoma a novší).</li>
    <li><b>Hlas:</b> skratka „Do mozgu“ v appke Skratky, spúšťaš ju cez Siri.</li></ul>
    <p style="margin:10px 0 0;font-size:12px;color:var(--faint)">Brain ${VERSION}</p></div></section>`;
}
function bindAccount(m) {
  const msg = t => { const x = m.querySelector("#bzAccMsg"); if (x) x.textContent = t; };
  m.querySelector("#bzSync").onclick = () => { flush(); for (const c of [...fetched]) load(c, true); setTimeout(refreshAccount, 1200); };
  m.querySelector("#bzOut").onclick = async e => {
    const b = e.currentTarget; if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = queue.length ? `Odhlásiť? ${queue.length} zmien ešte nie je odoslaných` : "Naozaj odhlásiť?"; return; }
    try { navigator.serviceWorker && navigator.serviceWorker.controller && navigator.serviceWorker.controller.postMessage({ type: "logout" }); } catch (x) {}
    await IDB.clear(); await sb.auth.signOut(); location.reload();
  };
  m.querySelector("#bzExp").onclick = async () => {
    msg("Pripravujem zálohu…");
    try { const j = await exportAll(); const n = Object.values(j.collections).reduce((a, c) => a + Object.keys(c).length, 0); await dlApi.save({ filename: `brain-zaloha-${new Date().toISOString().slice(0, 10)}.json`, data: JSON.stringify(j, null, 1) }); msg(`Záloha stiahnutá: ${n} záznamov.`); }
    catch (x) { msg("Zálohu sa nepodarilo vytvoriť" + (isNetErr(x) ? " – nie si online." : ": " + (x.message || x))); }
  };
  m.querySelector("#bzImpA").onchange = async e => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try { const n = await importBackup(f, msg); msg(`Obnovené: ${n} záznamov.`); } catch (x) { msg("Obnova zlyhala: " + (x.message || x)); }
  };
}
window.brainAccount = {
  html: () => `<div class="view"><div class="band" style="--b1:var(--wn-1);--b2:var(--wn-2)"><div><div class="eyebrow">Prihlásenie, synchronizácia, záloha</div><h1>Účet</h1></div></div><div id="bzAcc" style="display:flex;flex-direction:column;gap:16px"></div></div>`,
  bind: m => { accEl = m.querySelector("#bzAcc"); refreshAccount(); }
};

/* ---------- Štart ---------- */
function storedSession() {
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/^sb-.*-auth-token$/.test(k)) { const v = JSON.parse(localStorage.getItem(k)); return v && (v.currentSession || v); } } } catch (e) {}
  return null;
}
function startRealtime() {
  try {
    sb.channel("docs-" + uid).on("postgres_changes", { event: "*", schema: "public", table: "docs" }, pl => {
      const row = pl.new && Object.keys(pl.new).length ? pl.new : pl.old;
      if (!row || (row.owner && row.owner !== uid) || !row.coll || !row.id) return;
      if (queue.some(o => o.coll === row.coll && o.id === row.id)) return;
      if (!cache.has(row.coll)) return;
      if (pl.eventType === "DELETE") cache.get(row.coll).delete(row.id); else cache.get(row.coll).set(row.id, pl.new.data);
      notify(row.coll); persist(row.coll);
    }).subscribe();
  } catch (e) {}
}
let resyncAt = 0;
function resync() {
  if (!uid) return; flush();
  if (Date.now() - resyncAt < 15000) return; resyncAt = Date.now();
  for (const c of [...fetched]) load(c, true);
}
async function boot() {
  if (!CONFIGURED || !window.supabase) { showSetup(); return false; }
  sb = window.supabase.createClient(URL0, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  const r = await Promise.race([sb.auth.getSession().then(x => x.data && x.data.session).catch(() => null), new Promise(res => setTimeout(() => res("timeout"), 4000))]);
  session = r && r !== "timeout" ? r : storedSession();
  if (!session || !session.user) session = await showLogin();
  uid = session.user.id; email = session.user.email || "";
  postSW();
  sb.auth.onAuthStateChange((ev, s) => { if (s) { session = s; postSW(); } if (ev === "SIGNED_OUT") location.reload(); });
  queue = (await IDB.get(`q:${uid}`)) || [];
  startRealtime(); flush();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") resync(); });
  window.addEventListener("online", resync);
  setInterval(() => { if (queue.length) flush(); }, 30000);
  checkEmpty();
  return true;
}
let bootP = null;
const ensure = () => bootP || (bootP = boot().catch(e => { console.error(e); return false; }));
window.claude = {
  use: async name => {
    if (name === "sample") return null;          // AI v samostatnej appke zatiaľ vypnuté
    if (!(await ensure())) return null;
    if (name === "db") return dbApi;
    if (name === "assets") return assetsApi;
    if (name === "downloads") return dlApi;
    return null;
  }
};
})();
