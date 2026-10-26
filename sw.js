/* Brain – service worker: appka funguje offline a zobrazuje fotky zo súkromného úložiska. */
const V = "brain-v1";
const SHELL = ["./", "index.html", "shim.js", "config.js", "vendor/supabase.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/maskable-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith("brain-v") && k !== V).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

let AUTH = null;
self.addEventListener("message", e => {
  const d = e.data || {};
  if (d.type === "auth") { AUTH = d; e.waitUntil(caches.open("brain-meta").then(c => c.put("__auth", new Response(JSON.stringify(d))))); }
  if (d.type === "logout") { AUTH = null; e.waitUntil(Promise.all([caches.delete("brain-meta"), caches.delete("brain-blobs")])); }
});
async function auth() {
  if (AUTH) return AUTH;
  const r = await (await caches.open("brain-meta")).match("__auth");
  if (r) AUTH = await r.json();
  return AUTH;
}
async function freshAuth() {
  const cl = await self.clients.matchAll({ includeUncontrolled: true });
  const old = AUTH && AUTH.token; cl.forEach(c => c.postMessage({ type: "need-auth" }));
  for (let i = 0; i < 15; i++) { await new Promise(r => setTimeout(r, 200)); if (AUTH && AUTH.token !== old) break; }
  return AUTH;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    const m = u.pathname.match(/\/_blob\/([0-9a-f]{32})$/);
    if (m) { e.respondWith(blob(req, m[1])); return; }
    e.respondWith(networkFirst(req)); return;
  }
  if (/(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) e.respondWith(staleWhileRevalidate(req));
});

async function networkFirst(req) {
  const c = await caches.open(V);
  try {
    const r = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
    if (r && r.ok) c.put(req, r.clone());
    return r;
  } catch (err) {
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === "navigate") { const idx = await c.match("index.html"); if (idx) return idx; }
    return fetch(req);
  }
}
async function staleWhileRevalidate(req) {
  const c = await caches.open("brain-fonts");
  const hit = await c.match(req);
  const net = fetch(req).then(r => { if (r && (r.ok || r.type === "opaque")) c.put(req, r.clone()); return r; }).catch(() => hit);
  return hit || net;
}
async function blob(req, id) {
  const c = await caches.open("brain-blobs");
  const hit = await c.match(req.url);
  if (hit) return hit;
  let a = await auth();
  if (!a) a = await freshAuth();
  if (!a) return new Response("Neprihlásený", { status: 401 });
  const get = a => fetch(`${a.url}/storage/v1/object/authenticated/assets/${a.uid}/${id}`, { headers: { Authorization: "Bearer " + a.token, apikey: a.key } });
  try {
    let r = await get(a);
    if (r.status === 400 || r.status === 401 || r.status === 403) { const b = await freshAuth(); if (b) r = await get(b); }
    if (!r.ok) return r;
    const body = await r.blob();
    const resp = new Response(body, { headers: { "Content-Type": r.headers.get("Content-Type") || body.type || "application/octet-stream", "Cache-Control": "max-age=31536000" } });
    await c.put(req.url, resp.clone());
    return resp;
  } catch (err) { return new Response("Offline", { status: 504 }); }
}
